// routes/cashmemo.routes.js

async function routes(fastify, options) {
  // Compound index for cashmemo aggregations (ESR rule: equality → range → low-cardinality).
  // labId scopes to one lab, createdAt walks the date window, isDeleted filters cheaply.
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

  // ============================================================================
  // GET /cashmemo/summary
  //
  // Query params:
  //   startDate  {number}  Unix ms (required)
  //   endDate    {number}  Unix ms (required)
  // ============================================================================
  fastify.get("/cashmemo/summary", async (req, reply) => {
    try {
      const startDate = parseInt(req.query.startDate);
      const endDate = parseInt(req.query.endDate);

      // TODO: replace with dynamic labId from auth context once multi-tenancy is wired up
      const labId = 123456;

      if (!startDate || !endDate || isNaN(startDate) || isNaN(endDate)) {
        return reply.code(400).send({ error: "startDate and endDate are required Unix ms timestamps" });
      }
      if (startDate > endDate) {
        return reply.code(400).send({ error: "startDate must be before endDate" });
      }

      const [result] = await fastify.mongo.db
        .collection("invoices")
        .aggregate(
          [
            // Stage 1: index-backed match — labId (equality) + createdAt (range)
            {
              $match: {
                labId,
                createdAt: { $gte: startDate, $lte: endDate },
              },
            },

            // Stage 2: split into three branches on the already-filtered subset
            {
              $facet: {
                // Branch A: financial + operational summary for active invoices
                active: [
                  { $match: { isDeleted: { $ne: true } } },
                  {
                    $group: {
                      _id: null,
                      totalInvoices: { $sum: 1 },
                      totalAmount: { $sum: { $ifNull: ["$totalAmount", 0] } },
                      labAdjustment: { $sum: { $ifNull: ["$labAdjustmentAmount", 0] } },
                      // referrer.commission and referrer.discount are embedded in the referrer object
                      referrerCommission: { $sum: { $ifNull: ["$referrer.commission", 0] } },
                      referrerDiscount: { $sum: { $ifNull: ["$referrer.discount", 0] } },
                      totalFinalPrice: { $sum: { $ifNull: ["$finalPrice", 0] } },
                      totalPaidAmount: { $sum: { $ifNull: ["$paidAmount", 0] } },
                      deliveredCount: { $sum: { $cond: [{ $eq: ["$isDelivered", true] }, 1, 0] } },
                      fullyPaidCount: { $sum: { $cond: [{ $gte: ["$paidAmount", "$finalPrice"] }, 1, 0] } },
                    },
                  },
                  {
                    $addFields: {
                      // totalDue = finalPrice − paidAmount (clamped ≥ 0)
                      totalDue: { $max: [0, { $subtract: ["$totalFinalPrice", "$totalPaidAmount"] }] },
                      // netProfit = finalPrice − commission (what the lab keeps after paying referrers)
                      netProfit: { $subtract: ["$totalFinalPrice", "$referrerCommission"] },
                    },
                  },
                  {
                    $project: {
                      _id: 0,
                      totalInvoices: 1,
                      totalAmount: 1,
                      referrerDiscount: 1,
                      labAdjustment: 1,
                      referrerCommission: 1,
                      totalFinalPrice: 1,
                      totalPaidAmount: 1,
                      totalDue: 1,
                      netProfit: 1,
                      deliveredCount: 1,
                      fullyPaidCount: 1,
                    },
                  },
                ],

                // Branch B: soft-deleted invoice count
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
          {
            hint: "idx_labId_createdAt_isDeleted",
            allowDiskUse: true,
          },
        )
        .toArray();

      const activeSummary = result.active[0] ?? {
        totalInvoices: 0,
        totalAmount: 0,
        referrerDiscount: 0,
        labAdjustment: 0,
        referrerCommission: 0,
        totalFinalPrice: 0,
        totalPaidAmount: 0,
        totalDue: 0,
        netProfit: 0,
        deliveredCount: 0,
        fullyPaidCount: 0,
      };

      return reply.send({
        ...activeSummary,
        deletedCount: result.deleted[0]?.deletedCount ?? 0,
        testCounts: result.testCounts ?? [],
      });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch cash memo summary" });
    }
  });
}

export default routes;
