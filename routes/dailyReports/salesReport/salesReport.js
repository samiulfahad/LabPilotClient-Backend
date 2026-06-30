// routes/testStats.js
import toObjectId from "../../../utils/db.js";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const salesReportQuerySchema = {
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

async function salesReportRoutes(fastify) {
  const invoicesCol = () => fastify.mongo.db.collection("invoices");
  const indoorCol = () => fastify.mongo.db.collection("indoorPatients");
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("onRequest", fastify.authorize("cashmemo"));

  // ── GET /test-stats/summary ─────────────────────────────────────────────────
  fastify.get("/test-stats/summary", salesReportQuerySchema, async (req, reply) => {
    try {
      const startDate = parseInt(req.query.startDate);
      const endDate = parseInt(req.query.endDate);
      const limit = req.query.limit ? parseInt(req.query.limit) : 50;

      if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

      // ── Outdoor (existing invoice-based) stats ──────────────────────────────
      const [outdoorResult] = await invoicesCol()
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

      // ── Indoor (IPD expense-based) stats ─────────────────────────────────────
      // Indoor patients store test/product purchases inside the `expenses` array,
      // each entry carrying its own `addedAt` timestamp — so we unwind+match on that
      // instead of a top-level createdAt like invoices use.
      const [indoorResult] = await indoorCol()
        .aggregate(
          [
            { $match: { labId: labId(req) } },
            { $unwind: "$expenses" },
            {
              $match: {
                "expenses.addedAt": { $gte: startDate, $lte: endDate },
                "expenses.type": { $in: ["test", "product"] },
              },
            },
            {
              $facet: {
                tests: [
                  { $match: { "expenses.type": "test" } },
                  {
                    $group: {
                      _id: "$expenses.itemId",
                      name: { $first: "$expenses.name" },
                      count: { $sum: { $ifNull: ["$expenses.quantity", 1] } },
                    },
                  },
                  { $sort: { count: -1 } },
                  { $limit: limit },
                  { $project: { _id: 0, testId: "$_id", name: 1, count: 1 } },
                ],
                products: [
                  { $match: { "expenses.type": "product" } },
                  {
                    $group: {
                      _id: "$expenses.itemId",
                      name: { $first: "$expenses.name" },
                      count: { $sum: { $ifNull: ["$expenses.quantity", 1] } },
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
        testCounts: outdoorResult?.tests ?? [],
        productCounts: outdoorResult?.products ?? [],
        indoorTestCounts: indoorResult?.tests ?? [],
        indoorProductCounts: indoorResult?.products ?? [],
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch test stats" });
    }
  });
}

export default salesReportRoutes;
