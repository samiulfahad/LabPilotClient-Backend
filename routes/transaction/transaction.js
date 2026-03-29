import toObjectId from "../../utils/db.js";

const summaryQuerySchema = {
  schema: {
    tags: ["Transactions"],
    summary: "Get invoice & collection summary grouped by staff for a date range",
    querystring: {
      type: "object",
      required: ["startDate", "endDate"],
      properties: {
        startDate: { type: "integer", description: "Start date as Unix timestamp (ms)" },
        endDate: { type: "integer", description: "End date as Unix timestamp (ms)" },
      },
    },
  },
};

async function transactionRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("invoices");
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);

  // ── GET /transactions/summary ─────────────────────────────────────────────
  //
  // Groups invoices by createdBy.id (staffId) and unwinds collections[]
  // so each payment entry is also attributed to its collector.
  //
  // Index recommendations (add once, reuse forever):
  //   db.invoices.createIndex({ labId:1, createdAt:1, "deletion.status":1 })
  //   db.invoices.createIndex({ labId:1, "createdBy.id":1 })
  //
  fastify.get("/transactions/summary", summaryQuerySchema, async (req, reply) => {
    const startDate = parseInt(req.query.startDate);
    const endDate = parseInt(req.query.endDate);

    if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

    try {
      // ── Pipeline A: Invoice stats per staff ──────────────────────────────
      const invoiceStatsPipeline = [
        {
          $match: {
            labId: labId(req),
            createdAt: { $gte: startDate, $lte: endDate },
            "deletion.status": false,
          },
        },
        // Sort newest first so $last picks the latest name for the same id
        { $sort: { createdAt: 1 } },
        {
          $group: {
            _id: "$createdBy.id",
            // Latest name wins when same id has different names over time
            latestName: { $last: "$createdBy.name" },
            totalInvoices: { $sum: 1 },
            totalFinal: { $sum: { $ifNull: ["$amount.final", 0] } },
            totalPaid: { $sum: { $ifNull: ["$amount.paid", 0] } },
            totalDue: {
              $sum: {
                $subtract: [{ $ifNull: ["$amount.final", 0] }, { $ifNull: ["$amount.paid", 0] }],
              },
            },
            invoices: {
              $push: {
                invoiceId: "$invoiceId",
                patient: "$patient.name",
                createdAt: "$createdAt",
                final: { $ifNull: ["$amount.final", 0] },
                paid: { $ifNull: ["$amount.paid", 0] },
                due: {
                  $subtract: [{ $ifNull: ["$amount.final", 0] }, { $ifNull: ["$amount.paid", 0] }],
                },
              },
            },
          },
        },
        // Cap invoices per staff to avoid huge payloads
        {
          $addFields: {
            invoices: { $slice: ["$invoices", 200] },
          },
        },
        { $sort: { totalFinal: -1 } },
      ];

      // ── Pipeline B: Collection stats per collector ───────────────────────
      // Unwind collections[] so each payment entry is evaluated independently.
      // Filter by the collection timestamp (at) within the requested window.
      const collectionStatsPipeline = [
        {
          $match: {
            labId: labId(req),
            "deletion.status": false,
            // Pre-filter: invoice must overlap the window (fast index hit)
            createdAt: { $gte: startDate - 90 * 24 * 60 * 60 * 1000, $lte: endDate },
          },
        },
        { $unwind: "$collections" },
        // Now filter on the exact collection timestamp
        {
          $match: {
            "collections.at": { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: "$collections.by.id",
            collectorName: { $last: "$collections.by.name" },
            totalCollected: { $sum: "$collections.amount" },
            collectionCount: { $sum: 1 },
            collections: {
              $push: {
                invoiceId: "$invoiceId",
                patient: "$patient.name",
                amount: "$collections.amount",
                at: "$collections.at",
              },
            },
          },
        },
        {
          $addFields: {
            collections: { $slice: ["$collections", 200] },
          },
        },
        { $sort: { totalCollected: -1 } },
      ];

      // Run both pipelines in parallel
      const [invoiceRows, collectionRows] = await Promise.all([
        col().aggregate(invoiceStatsPipeline, { allowDiskUse: true }).toArray(),
        col().aggregate(collectionStatsPipeline, { allowDiskUse: true }).toArray(),
      ]);

      // ── Merge by staffId ────────────────────────────────────────────────
      // Build a map from collectionRows keyed by collector id (stringified)
      const collectionMap = new Map(collectionRows.map((r) => [String(r._id), r]));

      const staff = invoiceRows.map((row) => {
        const staffId = String(row._id);
        const col = collectionMap.get(staffId) ?? {};
        collectionMap.delete(staffId); // mark as merged
        return {
          staffId,
          name: col.collectorName ?? row.latestName ?? "Unknown",
          // Invoice stats
          totalInvoices: row.totalInvoices,
          totalFinal: row.totalFinal,
          totalPaid: row.totalPaid,
          totalDue: row.totalDue,
          invoices: row.invoices,
          // Collection stats (may differ from invoice paid if collector ≠ creator)
          totalCollected: col.totalCollected ?? 0,
          collectionCount: col.collectionCount ?? 0,
          collections: col.collections ?? [],
        };
      });

      // Collectors who collected but created no invoices in this window
      for (const [, row] of collectionMap) {
        staff.push({
          staffId: String(row._id),
          name: row.collectorName ?? "Unknown",
          totalInvoices: 0,
          totalFinal: 0,
          totalPaid: 0,
          totalDue: 0,
          invoices: [],
          totalCollected: row.totalCollected,
          collectionCount: row.collectionCount,
          collections: row.collections,
        });
      }

      // ── Grand totals ────────────────────────────────────────────────────
      const totals = staff.reduce(
        (acc, s) => ({
          totalInvoices: acc.totalInvoices + s.totalInvoices,
          totalFinal: acc.totalFinal + s.totalFinal,
          totalPaid: acc.totalPaid + s.totalPaid,
          totalDue: acc.totalDue + s.totalDue,
          totalCollected: acc.totalCollected + s.totalCollected,
        }),
        { totalInvoices: 0, totalFinal: 0, totalPaid: 0, totalDue: 0, totalCollected: 0 },
      );

      return reply.send({ staff, totals });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch transaction summary" });
    }
  });
}

export default transactionRoutes;
