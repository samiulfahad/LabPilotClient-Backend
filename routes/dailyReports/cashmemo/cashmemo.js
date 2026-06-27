import toObjectId from "../../../utils/db.js";

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

const ipdSummaryQuerySchema = {
  schema: {
    tags: ["Cashmemo"],
    summary: "Get IPD cash memo summary for a date range — activity-based (expenses/discounts/payments added in range)",
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
  const ipdCol = () => fastify.mongo.db.collection("indoorPatients");
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
                      fullyPaidCount: 1,
                    },
                  },
                ],
                deleted: [
                  { $match: { "deletion.status": true } },
                  {
                    $group: {
                      _id: null,
                      deletedCount: { $sum: 1 },
                      totalAmountDeleted: { $sum: { $ifNull: ["$amount.initial", 0] } },
                    },
                  },
                  { $project: { _id: 0, deletedCount: 1, totalAmountDeleted: 1 } },
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
        fullyPaidCount: 0,
      };

      return reply.send({
        ...active,
        deletedCount: result.deleted[0]?.deletedCount ?? 0,
        totalAmountDeleted: result.deleted[0]?.totalAmountDeleted ?? 0,
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch cash memo summary" });
    }
  });

  // ── GET /cashmemo/ipd-summary ─────────────────────────────────────────────
  //
  // Activity-based IPD summary: shows what happened *within* the date range,
  // not which patients were admitted in the range.
  //
  //   expenses  → items whose addedAt   falls in [startDate, endDate]
  //   discounts → items whose appliedAt falls in [startDate, endDate]
  //   payments  → items whose collectedAt falls in [startDate, endDate]
  //
  // Response shape:
  // {
  //   totalExpenses   : number  — sum of expense line totals added in range
  //   expenseCount    : number  — number of expense lines added in range
  //   totalDiscounts  : number  — sum of discounts applied in range
  //   discountCount   : number  — number of discount entries applied in range
  //   totalCollected  : number  — sum of payments collected in range
  //   paymentCount    : number  — number of payment entries in range
  //   affectedPatients: number  — distinct patients with any activity in range
  // }
  fastify.get("/cashmemo/ipd-summary", ipdSummaryQuerySchema, async (req, reply) => {
    try {
      const startDate = parseInt(req.query.startDate);
      const endDate = parseInt(req.query.endDate);

      if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

      // Three parallel aggregations — one per activity type.
      // Each $unwinds the relevant sub-array, filters by timestamp in range,
      // then groups the matching items across all patients.

      const [expensesResult, paymentsResult] = await Promise.all([
        // ── Expenses added in range ──────────────────────────────────────────
        ipdCol()
          .aggregate(
            [
              { $match: { labId: labId(req) } },
              { $unwind: "$expenses" },
              { $match: { "expenses.addedAt": { $gte: startDate, $lte: endDate } } },
              {
                $group: {
                  _id: null,
                  totalExpenses: {
                    $sum: {
                      $ifNull: ["$expenses.total", { $multiply: ["$expenses.price", "$expenses.quantity"] }],
                    },
                  },
                  testCount: { $sum: { $cond: [{ $eq: ["$expenses.type", "test"] }, 1, 0] } },
                  productCount: { $sum: { $cond: [{ $eq: ["$expenses.type", "product"] }, 1, 0] } },
                  otherCount: { $sum: { $cond: [{ $not: [{ $in: ["$expenses.type", ["test", "product"]] }] }, 1, 0] } },
                  expensePatientIds: { $addToSet: "$_id" },
                },
              },
              {
                $project: {
                  _id: 0,
                  totalExpenses: 1,
                  testCount: 1,
                  productCount: 1,
                  otherCount: 1,
                  expensePatientCount: { $size: "$expensePatientIds" },
                },
              },
            ],
            { allowDiskUse: true },
          )
          .toArray(),

        // ── Payments collected in range ──────────────────────────────────────
        ipdCol()
          .aggregate(
            [
              { $match: { labId: labId(req) } },
              { $unwind: "$payments" },
              { $match: { "payments.collectedAt": { $gte: startDate, $lte: endDate } } },
              {
                $group: {
                  _id: null,
                  totalCollected: { $sum: "$payments.amount" },
                  paymentCount: { $sum: 1 },
                  paymentPatientIds: { $addToSet: "$_id" },
                },
              },
              {
                $project: {
                  _id: 0,
                  totalCollected: 1,
                  paymentCount: 1,
                  paymentPatientCount: { $size: "$paymentPatientIds" },
                },
              },
            ],
            { allowDiskUse: true },
          )
          .toArray(),
      ]);

      const expenses = expensesResult[0] ?? {
        totalExpenses: 0,
        testCount: 0,
        productCount: 0,
        otherCount: 0,
        expensePatientCount: 0,
      };
      const payments = paymentsResult[0] ?? {
        totalCollected: 0,
        paymentCount: 0,
        paymentPatientCount: 0,
      };

      return reply.send({
        totalExpenses: Math.round(expenses.totalExpenses),
        testCount: expenses.testCount,
        productCount: expenses.productCount,
        otherCount: expenses.otherCount,
        expensePatientCount: expenses.expensePatientCount,
        totalCollected: Math.round(payments.totalCollected),
        paymentCount: payments.paymentCount,
        paymentPatientCount: payments.paymentPatientCount,
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch IPD cash memo summary" });
    }
  });
}

export default cashmemoRoutes;
