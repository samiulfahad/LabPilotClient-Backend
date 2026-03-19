const summaryQuerySchema = {
  schema: {
    querystring: {
      type: "object",
      required: ["startDate", "endDate"],
      properties: {
        startDate: { type: "integer" },
        endDate:   { type: "integer" },
      },
    },
  },
};

async function routes(fastify) {
  const col = () => fastify.mongo.db.collection("invoices");

  // ── GET /commission/summary ───────────────────────────────────────────────
  fastify.get("/commission/summary", summaryQuerySchema, async (req, reply) => {
    const { startDate, endDate } = req.query;

    if (startDate > endDate)
      return reply.code(400).send({ error: "startDate must be before endDate" });

    const labId = 123456; // TODO: req.user.labId

    try {
      const rows = await col()
        .aggregate(
          [
            {
              $match: {
                labId,
                createdAt: { $gte: startDate, $lte: endDate },
                isDeleted: false,
                "referrer.name": { $exists: true, $type: "string" },
              },
            },
            {
              $group: {
                _id:              { $ifNull: ["$referrer.id", "$referrer.name"] },
                name:             { $first: "$referrer.name" },
                type:             { $first: "$referrer.type" },
                referrerId:       { $first: "$referrer.id" },
                totalCommission:  { $sum: { $ifNull: ["$amount.referrerCommission", 0] } },
                totalDiscount:    { $sum: { $ifNull: ["$amount.referrerDiscount",   0] } },
                totalFinal:       { $sum: { $ifNull: ["$amount.final",              0] } },
                totalNet:         { $sum: { $ifNull: ["$amount.net",                0] } },
                totalInvoices:    { $sum: 1 },
                invoices: {
                  $push: {
                    invoiceId:   "$invoiceId",
                    patientName: "$patient.name",
                    createdAt:   "$createdAt",
                    final:       { $ifNull: ["$amount.final",              0] },
                    net:         { $ifNull: ["$amount.net",                0] },
                    commission:  { $ifNull: ["$amount.referrerCommission", 0] },
                    discount:    { $ifNull: ["$amount.referrerDiscount",   0] },
                  },
                },
              },
            },
            {
              $addFields: {
                isRegistered: { $gt: ["$referrerId", null] },
                invoices:     { $slice: ["$invoices", 100] },
              },
            },
            { $sort: { totalCommission: -1, totalInvoices: -1 } },
          ],
          { hint: "idx_labId_createdAt_isDeleted", allowDiskUse: true }
        )
        .toArray();

      const registered   = [];
      const unregistered = [];
      let totalCommission = 0, totalDiscount = 0;
      let totalFinal = 0,      totalNet = 0, totalInvoices = 0;

      for (const row of rows) {
        totalCommission += row.totalCommission;
        totalDiscount   += row.totalDiscount;
        totalFinal      += row.totalFinal;
        totalNet        += row.totalNet;
        totalInvoices   += row.totalInvoices;

        const base = {
          totalCommission: row.totalCommission,
          totalDiscount:   row.totalDiscount,
          totalFinal:      row.totalFinal,
          totalNet:        row.totalNet,
          totalInvoices:   row.totalInvoices,
          invoices:        row.invoices,
        };

        if (row.isRegistered) {
          registered.push({
            referrerId: row.referrerId,
            name:       row.name ?? "Unknown",
            type:       row.type ?? "unknown",
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

export default routes;