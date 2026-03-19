// cashmemo.routes.js

const summaryQuerySchema = {
  schema: {
    querystring: {
      type: "object",
      required: ["startDate", "endDate"],
      properties: {
        startDate: { type: "integer" },
        endDate: { type: "integer" },
      },
    },
  },
};

async function routes(fastify) {
  // ── GET /cashmemo/summary ─────────────────────────────────────────────────
  fastify.get("/cashmemo/summary", summaryQuerySchema, async (req, reply) => {
    const { startDate, endDate } = req.query;

    if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

    const labId = 123456; // TODO: req.user.labId

    try {
      const [result] = await fastify.mongo.db
        .collection("invoices")
        .aggregate(
          [
            {
              $match: {
                labId,
                createdAt: { $gte: startDate, $lte: endDate },
              },
            },
            {
              $facet: {
                active: [
                  { $match: { isDeleted: false } },
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
                      deliveredCount: {
                        $sum: { $cond: [{ $eq: ["$isDelivered", true] }, 1, 0] },
                      },
                      fullyPaidCount: {
                        $sum: { $cond: [{ $gte: ["$amount.paid", "$amount.final"] }, 1, 0] },
                      },
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
                      totalDue: { $max: [0, { $subtract: ["$totalFinal", "$totalPaid"] }] },
                      deliveredCount: 1,
                      fullyPaidCount: 1,
                    },
                  },
                ],
                deleted: [{ $match: { isDeleted: true } }, { $count: "deletedCount" }],
                testCounts: [
                  { $match: { isDeleted: false } },
                  { $unwind: "$tests" },
                  { $group: { _id: "$tests.name", count: { $sum: 1 } } },
                  { $sort: { count: -1 } },
                  { $limit: 20 },
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
