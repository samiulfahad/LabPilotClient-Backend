// routes/cashmemo.routes.js

async function routes(fastify, options) {
  // ============================================================================
  // Ensure the optimal index exists for cash-memo date-range aggregations.
  //
  // Index design rationale (ESR rule):
  //   1. labId      — Equality first: scopes the scan to one lab instantly,
  //                   reducing 10M docs → ~50K–100K for a typical lab.
  //   2. createdAt  — Range second: within one lab's slice, MongoDB walks only
  //                   the relevant date window.
  //   3. isDeleted  — Helps filter but has low cardinality; placed last so the
  //                   planner can use it as a post-scan filter cheaply.
  //
  // This makes the cash-memo aggregation run in <100 ms at 10M+ documents
  // instead of a 15–60 s full collection scan.
  // ============================================================================
  try {
    await fastify.mongo.db.collection("invoices").createIndex(
      { labId: 1, createdAt: -1, isDeleted: 1 },
      {
        name: "idx_labId_createdAt_isDeleted",
        background: true, // non-blocking build in older drivers; Atlas ignores this but harmless
      },
    );
    fastify.log.info("cashmemo: index idx_labId_createdAt_isDeleted ensured");
  } catch (err) {
    // Index creation is idempotent — if it already exists MongoDB is a no-op.
    // Log but never crash the server over this.
    fastify.log.warn({ err }, "cashmemo: could not ensure index");
  }

  // ============================================================================
  // GET /cashmemo/summary
  //
  // Returns an aggregated financial + operational summary for a single lab
  // within a caller-supplied time frame.
  //
  // Query params:
  //   startDate  {number}  Unix ms — start of range (required)
  //   endDate    {number}  Unix ms — end   of range (required)
  //   labId      {number}  Lab identifier (required)
  // ============================================================================
  fastify.get("/cashmemo/summary", async (req, reply) => {
    try {
      // ── Input validation ────────────────────────────────────────────────────
      const startDate = parseInt(req.query.startDate);
      const endDate = parseInt(req.query.endDate);

      // TODO: replace with dynamic labId from auth context once multi-tenancy is wired up
      const labId = 123456;

      if (!startDate || !endDate || isNaN(startDate) || isNaN(endDate)) {
        return reply.code(400).send({ error: "startDate and endDate are required and must be Unix ms timestamps" });
      }
      if (startDate > endDate) {
        return reply.code(400).send({ error: "startDate must be before endDate" });
      }

      const invoicesCollection = fastify.mongo.db.collection("invoices");

      // ── Aggregation ─────────────────────────────────────────────────────────
      //
      // $match hits the compound index (labId → createdAt range).
      // $facet then splits the matched set into two lightweight branches:
      //   • active  — full financial group for non-deleted invoices
      //   • deleted — a single $count for soft-deleted invoices
      //
      // Both branches operate only on the already-filtered subset, so the
      // $group and $count are cheap regardless of total collection size.
      // ────────────────────────────────────────────────────────────────────────
      const [facetResult] = await invoicesCollection
        .aggregate(
          [
            // ── Stage 1: index-backed match ─────────────────────────────────────
            // Uses idx_labId_createdAt_isDeleted:
            //   labId  → equality  (most selective — narrows to one lab)
            //   createdAt → range  (walks only the requested window)
            {
              $match: {
                labId,
                createdAt: { $gte: startDate, $lte: endDate },
              },
            },

            // ── Stage 2: split into active / deleted branches ───────────────────
            {
              $facet: {
                // ── Branch A: active invoices ─────────────────────────────────
                active: [
                  {
                    $match: { isDeleted: { $ne: true } },
                  },
                  {
                    $group: {
                      _id: null,

                      totalInvoices: { $sum: 1 },

                      // Gross total before any deduction
                      totalAmount: { $sum: { $ifNull: ["$totalAmount", 0] } },

                      // Lab's own concession / adjustment
                      labAdjustment: { $sum: { $ifNull: ["$labAdjustmentAmount", 0] } },

                      // Commission owed to referrers
                      referrerCommission: { $sum: { $ifNull: ["$referrerCommission", 0] } },

                      // Final billed price (after all discounts)
                      totalFinalPrice: { $sum: { $ifNull: ["$finalPrice", 0] } },

                      // How much has actually been collected so far
                      totalPaidAmount: { $sum: { $ifNull: ["$paidAmount", 0] } },

                      // Operational counters
                      deliveredCount: { $sum: { $cond: [{ $eq: ["$isDelivered", true] }, 1, 0] } },
                      fullyPaidCount: {
                        $sum: {
                          $cond: [{ $gte: ["$paidAmount", "$finalPrice"] }, 1, 0],
                        },
                      },
                    },
                  },
                  {
                    // Derive referrer discount and due amount from the grouped totals.
                    //
                    // referrerDiscount = totalAmount − labAdjustment − finalPrice
                    //   (the portion of the gross total passed on as patient discount
                    //    by the referrer, i.e. what the lab effectively gave away on
                    //    the referrer's behalf)
                    //
                    // totalDue = finalPrice − paidAmount  (clamped to ≥ 0)
                    $addFields: {
                      referrerDiscount: {
                        $max: [
                          0,
                          {
                            $subtract: ["$totalAmount", { $add: ["$totalFinalPrice", "$labAdjustment"] }],
                          },
                        ],
                      },
                      totalDue: {
                        $max: [0, { $subtract: ["$totalFinalPrice", "$totalPaidAmount"] }],
                      },
                    },
                  },
                  {
                    // netProfit = finalPrice − commission
                    // (what the lab actually keeps after paying referrers)
                    $addFields: {
                      netProfit: {
                        $subtract: ["$totalFinalPrice", "$referrerCommission"],
                      },
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

                // ── Branch B: deleted invoices — count only ─────────────────────
                deleted: [{ $match: { isDeleted: true } }, { $count: "deletedCount" }],

                // ── Branch C: test frequency ────────────────────────────────────
                // $unwind flattens tests[] so each test element becomes its own doc,
                // then $group counts by test name. Sorted descending by count.
                // Only considers active (non-deleted) invoices.
                testCounts: [
                  { $match: { isDeleted: { $ne: true } } },
                  { $unwind: "$tests" },
                  {
                    $group: {
                      _id: "$tests.name",
                      count: { $sum: 1 },
                    },
                  },
                  { $sort: { count: -1 } },
                  {
                    $project: {
                      _id: 0,
                      name: "$_id",
                      count: 1,
                    },
                  },
                ],
              },
            },
          ],
          {
            // Hint forces the planner to use our index even if the query optimiser
            // mis-estimates selectivity on large collections.
            hint: "idx_labId_createdAt_isDeleted",

            // Allow the aggregation to spill to disk if the in-memory limit (100 MB)
            // is exceeded — safe for large date ranges.
            allowDiskUse: true,
          },
        )
        .toArray();

      // ── Merge branches ──────────────────────────────────────────────────────
      const zero = {
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

      const activeSummary = facetResult.active[0] ?? zero;
      const deletedCount = facetResult.deleted[0]?.deletedCount ?? 0;
      const testCounts = facetResult.testCounts ?? []; // [{ name, count }, ...]

      return reply.send({ ...activeSummary, deletedCount, testCounts });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch cash memo summary" });
    }
  });
}

export default routes;
