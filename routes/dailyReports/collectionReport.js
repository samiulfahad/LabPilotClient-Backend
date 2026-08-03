import toObjectId from "../../utils/db.js";

const summaryQuerySchema = {
  schema: {
    tags: ["Collection Report"],
    summary: "Get collection totals grouped by staff for a date range, split by source (OPD/IPD)",
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

// Mirrors PAYMENT_MODES in invoiceRoutes.js / indoorPatients.routes.js
const PAYMENT_MODES = ["cash", "bkash", "nagad", "card", "bank_transfer", "others"];

// Modes that represent money physically held (cash in hand, or anything not
// tracked through a bank/wallet rail) rather than settled automatically into
// an account. These are what staff need to reconcile and hand over at the
// end of the day — everything else (bkash/nagad/card/bank_transfer) settles
// electronically and has nothing physical to count.
const PHYSICAL_MODES = ["cash", "others"];

async function collectionReportRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("invoices");
  const indoorCol = () => fastify.mongo.db.collection("indoorPatients");
  const labId = (req) => toObjectId(req.user.labId);

  // Excludes soft-deleted indoor patients from every IPD collection figure.
  // Missing `deletion` field (pre-soft-delete legacy docs) still matches null.
  const notDeletedFilter = (req) => ({ labId: labId(req), "deletion.at": null });

  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("onRequest", fastify.authorize("collectionReport"));

  fastify.get("/collection-report/summary", summaryQuerySchema, async (req, reply) => {
    const startDate = parseInt(req.query.startDate);
    const endDate = parseInt(req.query.endDate);

    if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

    const isHospital = req.user.type === "hospital"; // diagnosticCenter labs have no IPD data
    const lookback = { $gte: startDate - 90 * 24 * 60 * 60 * 1000, $lte: endDate };

    try {
      // ── Collection stats per collector (OPD invoices) ────────────────────
      const collectionStatsPipeline = [
        { $match: { labId: labId(req), "deletion.status": false, createdAt: lookback } },
        { $unwind: "$collections" },
        { $match: { "collections.at": { $gte: startDate, $lte: endDate } } },
        {
          $group: {
            _id: "$collections.by.id",
            collectorName: { $last: "$collections.by.name" },
            totalCollected: { $sum: "$collections.amount" },
            // Cash + others, summed here (pre-slice) so it stays accurate
            // even when a collector has more than 200 transactions.
            physicalCollected: {
              $sum: {
                $cond: [{ $in: ["$collections.mode", PHYSICAL_MODES] }, "$collections.amount", 0],
              },
            },
            collections: {
              $push: {
                invoiceId: "$invoiceId",
                patient: "$patient.name",
                amount: "$collections.amount",
                at: "$collections.at",
                mode: "$collections.mode",
                source: "opd",
              },
            },
          },
        },
        { $addFields: { collections: { $slice: ["$collections", 200] } } },
      ];

      // ── Collection stats per collector (IPD payments) ────────────────────
      // Indoor patients keep payments in a flat `payments[]` array (not a
      // sub-invoice), so we look 90 days back to catch admissions started
      // earlier, then filter payments themselves to the requested window.
      // Diagnostic centers have no IPD module at all, so skip this query
      // entirely for them rather than hitting an irrelevant collection.
      // Soft-deleted admissions are excluded via notDeletedFilter so their
      // payments never contribute to a collector's totals.
      const indoorCollectionStatsPipeline = [
        { $match: { ...notDeletedFilter(req), admittedAt: lookback } },
        { $unwind: "$payments" },
        { $match: { "payments.collectedAt": { $gte: startDate, $lte: endDate } } },
        {
          $group: {
            _id: "$payments.collectedBy.id",
            collectorName: { $last: "$payments.collectedBy.name" },
            totalCollected: { $sum: "$payments.amount" },
            // Same cash+others accumulator as the OPD pipeline, kept in sync.
            physicalCollected: {
              $sum: {
                $cond: [{ $in: ["$payments.mode", PHYSICAL_MODES] }, "$payments.amount", 0],
              },
            },
            collections: {
              $push: {
                invoiceId: "$admissionId",
                patient: "$patient.name",
                amount: "$payments.amount",
                at: "$payments.collectedAt",
                mode: "$payments.mode",
                source: "ipd",
              },
            },
          },
        },
        { $addFields: { collections: { $slice: ["$collections", 200] } } },
      ];

      // ── Payment-method totals (OPD + IPD), grouped independently of staff ─
      // Computed as its own $group (not derived from the per-staff arrays
      // above) because those are sliced to 200 entries each — summing from
      // the truncated lists would silently undercount the mode breakdown on
      // busy days.
      const opdModeTotalsPipeline = [
        { $match: { labId: labId(req), "deletion.status": false, createdAt: lookback } },
        { $unwind: "$collections" },
        { $match: { "collections.at": { $gte: startDate, $lte: endDate } } },
        { $group: { _id: "$collections.mode", total: { $sum: "$collections.amount" } } },
      ];

      const ipdModeTotalsPipeline = [
        { $match: { ...notDeletedFilter(req), admittedAt: lookback } },
        { $unwind: "$payments" },
        { $match: { "payments.collectedAt": { $gte: startDate, $lte: endDate } } },
        { $group: { _id: "$payments.mode", total: { $sum: "$payments.amount" } } },
      ];

      const [opdCollectionRows, ipdCollectionRows, opdModeRows, ipdModeRows] = await Promise.all([
        col().aggregate(collectionStatsPipeline, { allowDiskUse: true }).toArray(),
        isHospital ? indoorCol().aggregate(indoorCollectionStatsPipeline, { allowDiskUse: true }).toArray() : [],
        col().aggregate(opdModeTotalsPipeline, { allowDiskUse: true }).toArray(),
        isHospital ? indoorCol().aggregate(ipdModeTotalsPipeline, { allowDiskUse: true }).toArray() : [],
      ]);

      // ── Merge OPD + IPD rows by collector id, keeping source split ───────
      const collectionMap = new Map();
      for (const row of opdCollectionRows) {
        collectionMap.set(String(row._id), {
          collectorName: row.collectorName,
          opdCollected: row.totalCollected,
          ipdCollected: 0,
          physicalCollected: row.physicalCollected,
          collections: [...row.collections],
        });
      }
      for (const row of ipdCollectionRows) {
        const key = String(row._id);
        const existing = collectionMap.get(key);
        if (existing) {
          existing.ipdCollected += row.totalCollected;
          existing.physicalCollected += row.physicalCollected;
          existing.collections.push(...row.collections);
          existing.collectorName = existing.collectorName ?? row.collectorName;
        } else {
          collectionMap.set(key, {
            collectorName: row.collectorName,
            opdCollected: 0,
            ipdCollected: row.totalCollected,
            physicalCollected: row.physicalCollected,
            collections: [...row.collections],
          });
        }
      }

      const staff = [];
      for (const [staffId, row] of collectionMap) {
        row.collections.sort((a, b) => a.at - b.at);
        staff.push({
          staffId,
          name: row.collectorName ?? "Unknown",
          totalCollected: row.opdCollected + row.ipdCollected,
          opdCollected: row.opdCollected,
          ipdCollected: row.ipdCollected,
          physicalCollected: row.physicalCollected,
          collections: row.collections.slice(0, 200),
        });
      }
      staff.sort((a, b) => b.totalCollected - a.totalCollected);

      // ── Grand totals ────────────────────────────────────────────────────
      const totals = staff.reduce(
        (acc, s) => ({
          totalCollected: acc.totalCollected + s.totalCollected,
          opdCollected: acc.opdCollected + s.opdCollected,
          ipdCollected: acc.ipdCollected + s.ipdCollected,
          physicalCollected: acc.physicalCollected + s.physicalCollected,
        }),
        { totalCollected: 0, opdCollected: 0, ipdCollected: 0, physicalCollected: 0 },
      );

      // ── Payment-method breakdown ─────────────────────────────────────────
      const byMode = Object.fromEntries(PAYMENT_MODES.map((m) => [m, 0]));
      for (const row of [...opdModeRows, ...ipdModeRows]) {
        const mode = PAYMENT_MODES.includes(row._id) ? row._id : "others";
        byMode[mode] += row.total;
      }
      totals.byMode = byMode;

      return reply.send({ staff, totals });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch collection report" });
    }
  });
}

export default collectionReportRoutes;
