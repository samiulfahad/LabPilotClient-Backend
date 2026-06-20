// routes/testStats.js
import toObjectId from "../../utils/db.js";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const testStatsQuerySchema = {
  schema: {
    tags: ["Test Stats"],
    summary: "Get test and product order counts for a date range",
    querystring: {
      type: "object",
      required: ["startDate", "endDate"],
      properties: {
        startDate: { type: "integer", description: "Start date as Unix timestamp (ms)" },
        endDate: { type: "integer", description: "End date as Unix timestamp (ms)" },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 50,
          description: "Max number of items to return per category",
        },
      },
    },
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

async function testStatRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("invoices");
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("onRequest", fastify.authorize("cashmemo"));

  // ── GET /test-stats/summary ─────────────────────────────────────────────────
  fastify.get("/test-stats/summary", testStatsQuerySchema, async (req, reply) => {
    try {
      const startDate = parseInt(req.query.startDate);
      const endDate = parseInt(req.query.endDate);
      const limit = req.query.limit ? parseInt(req.query.limit) : 50;

      if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

      const [result] = await col()
        .aggregate(
          [
            {
              $match: {
                labId: labId(req),
                createdAt: { $gte: startDate, $lte: endDate },
                "deletion.status": false,
              },
            },
            {
              $facet: {
                tests: [
                  { $unwind: "$tests" },
                  {
                    $group: {
                      _id: "$tests.testId",
                      name: { $first: "$tests.name" },
                      count: { $sum: 1 },
                    },
                  },
                  { $sort: { count: -1 } },
                  { $limit: limit },
                  { $project: { _id: 0, testId: "$_id", name: 1, count: 1 } },
                ],
                products: [
                  { $unwind: "$products" },
                  {
                    $group: {
                      _id: "$products.productId",
                      name: { $first: "$products.name" },
                      count: { $sum: { $ifNull: ["$products.quantity", 1] } },
                    },
                  },
                  { $sort: { count: -1 } },
                  { $limit: limit },
                  { $project: { _id: 0, productId: "$_id", name: 1, count: 1 } },
                ],
              },
            },
          ],
          { allowDiskUse: true },
        )
        .toArray();

      return reply.send({
        testCounts: result.tests,
        productCounts: result.products,
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch test stats" });
    }
  });
}

export default testStatRoutes;
