// routes/salesReportRoutes.js
import toObjectId from "../../utils/db.js";

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
  const isHospital = (req) => req.user.type === "hospital"; // diagnosticCenter labs have no IPD module

  // Excludes soft-deleted indoor patients from every indoor test/product/
  // medicine/service figure. Missing `deletion` field (pre-soft-delete legacy
  // docs) still matches null.
  const notDeletedFilter = (req) => ({ labId: labId(req), "deletion.at": null });

  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("onRequest", fastify.authorize("salesReport"));

  // ── GET /test-stats/summary ─────────────────────────────────────────────────
  fastify.get("/test-stats/summary", salesReportQuerySchema, async (req, reply) => {
    try {
      const startDate = parseInt(req.query.startDate);
      const endDate = parseInt(req.query.endDate);
      const limit = req.query.limit ? parseInt(req.query.limit) : 50;

      if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

      // ── Outdoor (invoice-based) stats ───────────────────────────────────────
      // Note: outdoor invoices only carry "tests" and "products" (products can be
      // product/service/medicine per PRODUCT_TYPES) — split products by type here
      // so medicine/service show separately, matching the indoor breakdown below.
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
                  { $match: { "products.type": "product" } },
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
                medicines: [
                  { $unwind: "$products" },
                  { $match: { "products.type": "medicine" } },
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
                services: [
                  { $unwind: "$products" },
                  { $match: { "products.type": "service" } },
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

      // ── Indoor (IPD expense-based) stats — hospitals only ───────────────────
      // expenses.type is one of: "medicine" | "product" | "test" | "service" | "other"
      // diagnosticCenter labs have no IPD module — skip this aggregation entirely
      // rather than querying indoorPatients for a collection that's always empty.
      // Soft-deleted admissions are excluded via notDeletedFilter so their
      // expenses never contribute to indoor test/product/medicine/service counts.
      let indoorResult = [{ tests: [], products: [], medicines: [], services: [] }];

      if (isHospital(req)) {
        [indoorResult[0]] = await indoorCol()
          .aggregate(
            [
              { $match: notDeletedFilter(req) },
              { $unwind: "$expenses" },
              {
                $match: {
                  "expenses.addedAt": { $gte: startDate, $lte: endDate },
                  "expenses.type": { $in: ["test", "product", "medicine", "service", "other"] },
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
                  medicines: [
                    { $match: { "expenses.type": "medicine" } },
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
                  // "service" and "other" expense types are grouped together as
                  // one "services" bucket for reporting purposes.
                  services: [
                    { $match: { "expenses.type": { $in: ["service", "other"] } } },
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
      }

      return reply.send({
        testCounts: outdoorResult?.tests ?? [],
        productCounts: outdoorResult?.products ?? [],
        medicineCounts: outdoorResult?.medicines ?? [],
        serviceCounts: outdoorResult?.services ?? [],
        indoorTestCounts: indoorResult[0]?.tests ?? [],
        indoorProductCounts: indoorResult[0]?.products ?? [],
        indoorMedicineCounts: indoorResult[0]?.medicines ?? [],
        indoorServiceCounts: indoorResult[0]?.services ?? [],
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch test stats" });
    }
  });
}

export default salesReportRoutes;
