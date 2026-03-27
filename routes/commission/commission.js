import toObjectId from "../../utils/db.js";

const summaryQuerySchema = {
  schema: {
    tags: ["Commission"],
    summary: "Get commission summary for a date range",
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

async function commissionRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("invoices");
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);

  // ── GET /commission/summary ───────────────────────────────────────────────
  fastify.get("/commission/summary", summaryQuerySchema, async (req, reply) => {
    const startDate = parseInt(req.query.startDate);
    const endDate = parseInt(req.query.endDate);

    if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

    try {
      const rows = await col()
        .aggregate(
          [
            {
              $match: {
                labId: labId(req),
                createdAt: { $gte: startDate, $lte: endDate },
                "deletion.status": false,
                "referrer.name": { $exists: true, $type: "string" },
              },
            },
            {
              $group: {
                _id: { $ifNull: ["$referrer.id", "$referrer.name"] },
                name: { $first: "$referrer.name" },
                type: { $first: "$referrer.type" },
                referrerId: { $first: "$referrer.id" },
                totalCommission: { $sum: { $ifNull: ["$amount.referrerCommission", 0] } },
                totalDiscount: { $sum: { $ifNull: ["$amount.referrerDiscount", 0] } },
                totalFinal: { $sum: { $ifNull: ["$amount.final", 0] } },
                totalNet: { $sum: { $ifNull: ["$amount.net", 0] } },
                totalInvoices: { $sum: 1 },
                invoices: {
                  $push: {
                    invoiceId: "$invoiceId",
                    patientName: "$patient.name",
                    createdAt: "$createdAt",
                    final: { $ifNull: ["$amount.final", 0] },
                    net: { $ifNull: ["$amount.net", 0] },
                    commission: { $ifNull: ["$amount.referrerCommission", 0] },
                    discount: { $ifNull: ["$amount.referrerDiscount", 0] },
                  },
                },
              },
            },
            {
              $addFields: {
                isRegistered: { $gt: ["$referrerId", null] },
                invoices: { $slice: ["$invoices", 100] },
              },
            },
            { $sort: { totalCommission: -1, totalInvoices: -1 } },
          ],
          { allowDiskUse: true },
        )
        .toArray();

      const registered = [];
      const unregistered = [];
      let totalCommission = 0,
        totalDiscount = 0;
      let totalFinal = 0,
        totalNet = 0,
        totalInvoices = 0;

      for (const row of rows) {
        totalCommission += row.totalCommission;
        totalDiscount += row.totalDiscount;
        totalFinal += row.totalFinal;
        totalNet += row.totalNet;
        totalInvoices += row.totalInvoices;

        const base = {
          totalCommission: row.totalCommission,
          totalDiscount: row.totalDiscount,
          totalFinal: row.totalFinal,
          totalNet: row.totalNet,
          totalInvoices: row.totalInvoices,
          invoices: row.invoices,
        };

        if (row.isRegistered) {
          registered.push({
            referrerId: row.referrerId,
            name: row.name ?? "Unknown",
            type: row.type ?? "unknown",
            ...base,
          });
        } else {
          unregistered.push({ referredBy: row.name ?? row._id, ...base });
        }
      }

      return reply.send({
        registered,
        unregistered,
        totals: { totalCommission, totalDiscount, totalFinal, totalNet, totalInvoices },
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch commission summary" });
    }
  });
}

export default commissionRoutes;
