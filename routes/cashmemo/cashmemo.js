import toObjectId from "../../utils/db.js";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const summaryQuerySchema = {
  schema: {
    tags: ["Cashmemo"],
    summary: "Get cash memo summary for a date range",
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

// ─── Routes ───────────────────────────────────────────────────────────────────

async function cashmemoRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("invoices");
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("onRequest", fastify.authorize("cashmemo"));

  // ── GET /cashmemo/summary ─────────────────────────────────────────────────
  fastify.get("/cashmemo/summary", summaryQuerySchema, async (req, reply) => {
    try {
      const startDate = parseInt(req.query.startDate);
      const endDate = parseInt(req.query.endDate);

      if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

      const [result] = await col()
        .aggregate(
          [
            {
              $match: {
                labId: labId(req),
                createdAt: { $gte: startDate, $lte: endDate },
              },
            },
            {
              $facet: {
                active: [
                  { $match: { "deletion.status": false } },
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
                        $sum: { $cond: [{ $eq: ["$delivery.status", true] }, 1, 0] },
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
                deleted: [{ $match: { "deletion.status": true } }, { $count: "deletedCount" }],
                testCounts: [
                  { $match: { "deletion.status": false } },
                  { $unwind: "$tests" },
                  { $group: { _id: "$tests.name", count: { $sum: 1 } } },
                  { $sort: { count: -1 } },
                  { $limit: 20 },
                  { $project: { _id: 0, name: "$_id", count: 1 } },
                ],
                // ── Product counts: sum quantities, not just occurrences ──────
                productCounts: [
                  { $match: { "deletion.status": false } },
                  { $unwind: "$products" },
                  {
                    $group: {
                      _id: "$products.name",
                      count: { $sum: { $ifNull: ["$products.quantity", 1] } },
                    },
                  },
                  { $sort: { count: -1 } },
                  { $limit: 20 },
                  { $project: { _id: 0, name: "$_id", count: 1 } },
                ],
              },
            },
          ],
          { allowDiskUse: true },
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
        productCounts: result.productCounts ?? [],
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch cash memo summary" });
    }
  });
}

export default cashmemoRoutes;
