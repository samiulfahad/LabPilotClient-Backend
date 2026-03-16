async function routes(fastify) {
  // Compound index: labId (equality) → createdAt (range) → isDeleted (filter)
  try {
    await fastify.mongo.db
      .collection("invoices")
      .createIndex(
        { labId: 1, createdAt: -1, isDeleted: 1 },
        { name: "idx_labId_createdAt_isDeleted", background: true },
      );
  } catch (err) {
    fastify.log.warn({ err }, "cashmemo: could not ensure index");
  }

  // ── GET /cashmemo/summary ─────────────────────────────────────────────────
  // Query params: startDate {number} Unix ms, endDate {number} Unix ms
  fastify.get("/cashmemo/summary", async (req, reply) => {
    try {
      const startDate = parseInt(req.query.startDate);
      const endDate = parseInt(req.query.endDate);

      // TODO: replace with dynamic labId from auth context once multi-tenancy is wired up
      const labId = 123456;

      if (!startDate || !endDate || isNaN(startDate) || isNaN(endDate))
        return reply.code(400).send({ error: "startDate and endDate are required Unix ms timestamps" });
      if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

      const [result] = await fastify.mongo.db
        .collection("invoices")
        .aggregate(
          [
            // Stage 1: index-backed match
            { $match: { labId, createdAt: { $gte: startDate, $lte: endDate } } },

            // Stage 2: three parallel branches
            {
              $facet: {
                // Branch A: financial + operational summary for active invoices
                active: [
                  { $match: { isDeleted: { $ne: true } } },
                  {
                    $group: {
                      _id: null,
                      totalInvoices: { $sum: 1 },
                      initial: { $sum: { $ifNull: ["$amount.initial", 0] } },
                      labAdjustment: { $sum: { $ifNull: ["$amount.labAdjustment", 0] } },
                      referrerDiscount: { $sum: { $ifNull: ["$amount.referrerDiscount", 0] } },
                      referrerCommission: { $sum: { $ifNull: ["$amount.referrerCommission", 0] } },
                      totalFinal: { $sum: { $ifNull: ["$amount.final", 0] } },
                      totalNet: { $sum: { $ifNull: ["$amount.net", 0] } },
                      totalPaid: { $sum: { $ifNull: ["$amount.paid", 0] } },
                      deliveredCount: { $sum: { $cond: [{ $eq: ["$isDelivered", true] }, 1, 0] } },
                      fullyPaidCount: { $sum: { $cond: [{ $gte: ["$amount.paid", "$amount.final"] }, 1, 0] } },
                    },
                  },
                  {
                    $addFields: {
                      totalDue: { $max: [0, { $subtract: ["$totalFinal", "$totalPaid"] }] },
                    },
                  },
                  {
                    $project: {
                      _id: 0,
                      totalInvoices: 1,
                      initial: 1,
                      labAdjustment: 1,
                      referrerDiscount: 1,
                      referrerCommission: 1,
                      totalFinal: 1,
                      totalNet: 1,
                      totalPaid: 1,
                      totalDue: 1,
                      deliveredCount: 1,
                      fullyPaidCount: 1,
                    },
                  },
                ],

                // Branch B: soft-deleted count
                deleted: [{ $match: { isDeleted: true } }, { $count: "deletedCount" }],

                // Branch C: test frequency ranking (active invoices only)
                testCounts: [
                  { $match: { isDeleted: { $ne: true } } },
                  { $unwind: "$tests" },
                  { $group: { _id: "$tests.name", count: { $sum: 1 } } },
                  { $sort: { count: -1 } },
                  { $project: { _id: 0, name: "$_id", count: 1 } },
                ],
              },
            },
          ],
          { hint: "idx_labId_createdAt_isDeleted", allowDiskUse: true },
        )
        .toArray();

      const active = result.active[0] ?? {
        totalInvoices: 0,
        initial: 0,
        labAdjustment: 0,
        referrerDiscount: 0,
        referrerCommission: 0,
        totalFinal: 0,
        totalNet: 0,
        totalPaid: 0,
        totalDue: 0,
        deliveredCount: 0,
        fullyPaidCount: 0,
      };

      return reply.send({
        ...active,
        deletedCount: result.deleted[0]?.deletedCount ?? 0,
        testCounts: result.testCounts ?? [],
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch cash memo summary" });
    }
  });
}

export default routes;
