async function routes(fastify) {
  // ── GET /commission/summary ───────────────────────────────────────────────
  // Query params: startDate {number} Unix ms, endDate {number} Unix ms
  fastify.get("/commission/summary", async (req, reply) => {
    try {
      const startDate = parseInt(req.query.startDate);
      const endDate = parseInt(req.query.endDate);
      const labId = 123456; // TODO: replace with auth context

      if (!startDate || !endDate || isNaN(startDate) || isNaN(endDate))
        return reply.code(400).send({ error: "startDate and endDate are required Unix ms timestamps" });
      if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

      const rows = await fastify.mongo.db
        .collection("invoices")
        .aggregate(
          [
            // 1. Index-backed match
            {
              $match: {
                labId,
                createdAt: { $gte: startDate, $lte: endDate },
                isDeleted: { $ne: true },
                "referrer.name": { $ne: null },
              },
            },

            // 2. Sort ASC so $last picks the most recent name
            { $sort: { createdAt: 1 } },

            // 3. Group — registered keyed by referrer.id, unregistered by referrer.name
            {
              $group: {
                _id: { $ifNull: ["$referrer.id", "$referrer.name"] },
                name: { $last: "$referrer.name" },
                type: { $last: "$referrer.type" },
                isRegistered: { $first: { $toBool: "$referrer.id" } },
                referrerId: { $first: "$referrer.id" },
                totalCommission: { $sum: { $ifNull: ["$amount.referrerCommission", 0] } },
                totalDiscount: { $sum: { $ifNull: ["$amount.referrerDiscount", 0] } },
                totalInvoices: { $sum: 1 },
                invoices: {
                  $push: {
                    invoiceId: "$invoiceId",
                    patient: { name: "$patient.name" },
                    createdAt: "$createdAt",
                    final: { $ifNull: ["$amount.final", 0] },
                    commission: { $ifNull: ["$amount.referrerCommission", 0] },
                    discount: { $ifNull: ["$amount.referrerDiscount", 0] },
                  },
                },
              },
            },

            // 4. Highest commission first
            { $sort: { totalCommission: -1, totalInvoices: -1 } },
          ],
          { hint: "idx_labId_createdAt_isDeleted", allowDiskUse: true },
        )
        .toArray();

      const registered = [];
      const unregistered = [];

      for (const row of rows) {
        const base = {
          totalCommission: row.totalCommission,
          totalDiscount: row.totalDiscount,
          totalInvoices: row.totalInvoices,
          invoices: row.invoices,
        };
        if (row.isRegistered && row.referrerId) {
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
        totals: {
          totalCommission: rows.reduce((s, r) => s + r.totalCommission, 0),
          totalDiscount: rows.reduce((s, r) => s + r.totalDiscount, 0),
          totalInvoices: rows.reduce((s, r) => s + r.totalInvoices, 0),
        },
      });
    } catch (err) {
      // console.log(err);
      return reply.code(500).send({ error: "Failed to fetch commission summary" });
    }
  });
}

export default routes;
