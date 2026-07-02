import toObjectId from "../../../utils/db.js";

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

async function collectionReportRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("invoices");
  const indoorCol = () => fastify.mongo.db.collection("indoorPatients");
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/collection-report/summary", summaryQuerySchema, async (req, reply) => {
    const startDate = parseInt(req.query.startDate);
    const endDate = parseInt(req.query.endDate);

    if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

    const isHospital = req.user.type === "hospital"; // diagnosticCenter labs have no IPD data

    try {
      // ── Collection stats per collector (OPD invoices) ────────────────────
      const collectionStatsPipeline = [
        {
          $match: {
            labId: labId(req),
            "deletion.status": false,
            createdAt: { $gte: startDate - 90 * 24 * 60 * 60 * 1000, $lte: endDate },
          },
        },
        { $unwind: "$collections" },
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
            collections: {
              $push: {
                invoiceId: "$invoiceId",
                patient: "$patient.name",
                amount: "$collections.amount",
                at: "$collections.at",
                source: "opd",
              },
            },
          },
        },
        {
          $addFields: {
            collections: { $slice: ["$collections", 200] },
          },
        },
      ];

      // ── Collection stats per collector (IPD payments) ────────────────────
      // Indoor patients keep payments in a flat `payments[]` array (not a
      // sub-invoice), so we look 90 days back to catch admissions started
      // earlier, then filter payments themselves to the requested window.
      // Diagnostic centers have no IPD module at all, so skip this query
      // entirely for them rather than hitting an irrelevant collection.
      const indoorCollectionStatsPipeline = [
        {
          $match: {
            labId: labId(req),
            admittedAt: { $gte: startDate - 90 * 24 * 60 * 60 * 1000, $lte: endDate },
          },
        },
        { $unwind: "$payments" },
        {
          $match: {
            "payments.collectedAt": { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: "$payments.collectedBy.id",
            collectorName: { $last: "$payments.collectedBy.name" },
            totalCollected: { $sum: "$payments.amount" },
            collections: {
              $push: {
                invoiceId: "$admissionId",
                patient: "$patient.name",
                amount: "$payments.amount",
                at: "$payments.collectedAt",
                source: "ipd",
              },
            },
          },
        },
        {
          $addFields: {
            collections: { $slice: ["$collections", 200] },
          },
        },
      ];

      const [opdCollectionRows, ipdCollectionRows] = await Promise.all([
        col().aggregate(collectionStatsPipeline, { allowDiskUse: true }).toArray(),
        isHospital ? indoorCol().aggregate(indoorCollectionStatsPipeline, { allowDiskUse: true }).toArray() : [],
      ]);

      // ── Merge OPD + IPD rows by collector id, keeping source split ───────
      const collectionMap = new Map();
      for (const row of opdCollectionRows) {
        collectionMap.set(String(row._id), {
          collectorName: row.collectorName,
          opdCollected: row.totalCollected,
          ipdCollected: 0,
          collections: [...row.collections],
        });
      }
      for (const row of ipdCollectionRows) {
        const key = String(row._id);
        const existing = collectionMap.get(key);
        if (existing) {
          existing.ipdCollected += row.totalCollected;
          existing.collections.push(...row.collections);
          existing.collectorName = existing.collectorName ?? row.collectorName;
        } else {
          collectionMap.set(key, {
            collectorName: row.collectorName,
            opdCollected: 0,
            ipdCollected: row.totalCollected,
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
        }),
        { totalCollected: 0, opdCollected: 0, ipdCollected: 0 },
      );

      return reply.send({ staff, totals });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch collection report" });
    }
  });
}

export default collectionReportRoutes;
