// routes/commission.routes.js

async function routes(fastify, options) {
  // ============================================================================
  // GET /commission/summary
  //
  // Query params:
  //   startDate  {number}  Unix ms (required)
  //   endDate    {number}  Unix ms (required)
  // ============================================================================
  fastify.get("/commission/summary", async (req, reply) => {
    try {
      const startDate = parseInt(req.query.startDate);
      const endDate = parseInt(req.query.endDate);
      const labId = 123456; // TODO: replace with auth context

      if (!startDate || !endDate || isNaN(startDate) || isNaN(endDate)) {
        return reply.code(400).send({ error: "startDate and endDate are required Unix ms timestamps" });
      }
      if (startDate > endDate) {
        return reply.code(400).send({ error: "startDate must be before endDate" });
      }

      const pipeline = [
        // 1. Scoped, index-backed match
        {
          $match: {
            labId,
            createdAt: { $gte: startDate, $lte: endDate },
            isDeleted: { $ne: true },
            "referrer.name": { $ne: null },
          },
        },

        // 2. Sort by createdAt ASC so $last picks the most recent name
        { $sort: { createdAt: 1 } },

        // 3. Group
        //    - registered  → keyed by referrer.id  (non-null)
        //    - unregistered → keyed by referrer.name (id is null)
        {
          $group: {
            _id: { $ifNull: ["$referrer.id", "$referrer.name"] },

            name: { $last: "$referrer.name" },
            type: { $last: "$referrer.type" },

            isRegistered: { $first: { $toBool: "$referrer.id" } },
            referrerId: { $first: "$referrer.id" },

            totalCommission: { $sum: { $ifNull: ["$referrer.commission", 0] } },
            totalDiscount: { $sum: { $ifNull: ["$referrer.discount", 0] } },
            totalInvoices: { $sum: 1 },

            invoices: {
              $push: {
                invoiceId: "$invoiceId",
                patient: { name: "$patient.name" },
                createdAt: "$createdAt",
                finalPrice: "$finalPrice",
                commission: { $ifNull: ["$referrer.commission", 0] },
                discount: { $ifNull: ["$referrer.discount", 0] },
              },
            },
          },
        },

        // 4. Highest commission first
        { $sort: { totalCommission: -1, totalInvoices: -1 } },
      ];

      const rows = await fastify.mongo.db
        .collection("invoices")
        .aggregate(pipeline, { hint: "idx_labId_createdAt_isDeleted", allowDiskUse: true })
        .toArray();

      const registered = [];
      const unregistered = [];

      for (const row of rows) {
        if (row.isRegistered && row.referrerId) {
          registered.push({
            referrerId: row.referrerId,
            name: row.name ?? "Unknown",
            type: row.type ?? "unknown",
            totalCommission: row.totalCommission,
            totalDiscount: row.totalDiscount,
            totalInvoices: row.totalInvoices,
            invoices: row.invoices,
          });
        } else {
          unregistered.push({
            referredBy: row.name ?? row._id,
            totalCommission: row.totalCommission,
            totalDiscount: row.totalDiscount,
            totalInvoices: row.totalInvoices,
            invoices: row.invoices,
          });
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
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch commission summary" });
    }
  });
}

export default routes;
