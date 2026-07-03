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

const ipdDiscountPatientsQuerySchema = {
  schema: {
    tags: ["Cashmemo"],
    summary: "Get patient-level breakdown of IPD discounts applied in a date range",
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

const ipdAdmittedPatientsQuerySchema = {
  schema: {
    tags: ["Cashmemo"],
    summary: "Get list of patients admitted within a date range",
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

const ipdReleasedPatientsQuerySchema = {
  schema: {
    tags: ["Cashmemo"],
    summary: "Get list of patients released within a date range",
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

const expenseSummaryQuerySchema = {
  schema: {
    tags: ["Cashmemo"],
    summary: "Get total lab (operational) expense for a date range",
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
  const expenseCol = () => fastify.mongo.db.collection("expenses");
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
  //   expenses  → items whose addedAt     falls in [startDate, endDate]
  //   discounts → items whose appliedAt   falls in [startDate, endDate]
  //   payments  → items whose collectedAt falls in [startDate, endDate]
  //   admitted/released → patients whose admittedAt/releasedAt falls in [startDate, endDate]
  //
  // NOTE: totalDue is bill vs. collection only (does NOT subtract discounts) —
  // discounts are surfaced separately so the UI never derives collected/due
  // by backing the discount out of the bill.
  fastify.get("/cashmemo/ipd-summary", ipdSummaryQuerySchema, async (req, reply) => {
    try {
      const startDate = parseInt(req.query.startDate);
      const endDate = parseInt(req.query.endDate);

      if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

      const [expensesResult, discountsResult, paymentsResult, admissionResult] = await Promise.all([
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

        // ── Discounts applied in range ────────────────────────────────────────
        ipdCol()
          .aggregate(
            [
              { $match: { labId: labId(req) } },
              { $unwind: "$discounts" },
              { $match: { "discounts.appliedAt": { $gte: startDate, $lte: endDate } } },
              {
                $group: {
                  _id: null,
                  totalDiscounts: { $sum: "$discounts.amount" },
                  discountCount: { $sum: 1 },
                  discountPatientIds: { $addToSet: "$_id" },
                },
              },
              {
                $project: {
                  _id: 0,
                  totalDiscounts: 1,
                  discountCount: 1,
                  discountPatientCount: { $size: "$discountPatientIds" },
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

        // ── Patients admitted / released in range ────────────────────────────
        ipdCol()
          .aggregate(
            [
              { $match: { labId: labId(req) } },
              {
                $facet: {
                  admitted: [{ $match: { admittedAt: { $gte: startDate, $lte: endDate } } }, { $count: "count" }],
                  released: [{ $match: { releasedAt: { $gte: startDate, $lte: endDate } } }, { $count: "count" }],
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
      const discounts = discountsResult[0] ?? { totalDiscounts: 0, discountCount: 0, discountPatientCount: 0 };
      const payments = paymentsResult[0] ?? {
        totalCollected: 0,
        paymentCount: 0,
        paymentPatientCount: 0,
      };
      const admittedCount = admissionResult[0]?.admitted?.[0]?.count ?? 0;
      const releasedCount = admissionResult[0]?.released?.[0]?.count ?? 0;

      const totalExpenses = Math.round(expenses.totalExpenses);
      const totalDiscounts = Math.round(discounts.totalDiscounts);
      const totalCollected = Math.round(payments.totalCollected);
      // Due = bill vs. collection only. Discounts are shown separately and are
      // never backed out of this figure.
      const totalDue = Math.max(0, totalExpenses - totalCollected);

      return reply.send({
        admittedCount,
        releasedCount,
        totalExpenses,
        testCount: expenses.testCount,
        productCount: expenses.productCount,
        otherCount: expenses.otherCount,
        expensePatientCount: expenses.expensePatientCount,
        totalDiscounts,
        discountCount: discounts.discountCount,
        discountPatientCount: discounts.discountPatientCount,
        totalCollected,
        paymentCount: payments.paymentCount,
        paymentPatientCount: payments.paymentPatientCount,
        totalDue,
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch IPD cash memo summary" });
    }
  });

  // ── GET /cashmemo/ipd-discount-patients ───────────────────────────────────
  // Patient-level breakdown of discounts applied within the date range, used
  // to drill into the "মোট ডিসকাউন্ট" figure on the indoor cashmemo tab.
  fastify.get("/cashmemo/ipd-discount-patients", ipdDiscountPatientsQuerySchema, async (req, reply) => {
    try {
      const startDate = parseInt(req.query.startDate);
      const endDate = parseInt(req.query.endDate);

      if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

      const patients = await ipdCol()
        .aggregate(
          [
            { $match: { labId: labId(req) } },
            { $unwind: "$discounts" },
            { $match: { "discounts.appliedAt": { $gte: startDate, $lte: endDate } } },
            {
              $group: {
                _id: "$_id",
                admissionId: { $first: "$admissionId" },
                patientName: { $first: "$patient.name" },
                totalDiscount: { $sum: "$discounts.amount" },
                discountCount: { $sum: 1 },
                discounts: {
                  $push: {
                    category: "$discounts.category",
                    amount: "$discounts.amount",
                    providedBy: "$discounts.providedBy",
                    note: "$discounts.note",
                    appliedAt: "$discounts.appliedAt",
                  },
                },
              },
            },
            { $sort: { totalDiscount: -1 } },
          ],
          { allowDiskUse: true },
        )
        .toArray();

      return reply.send({ patients });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch IPD discount patients" });
    }
  });

  // ── GET /cashmemo/ipd-admitted-patients ───────────────────────────────────
  // List of patients whose admittedAt falls within the date range, used to
  // drill into the "নতুন ভর্তি রোগী" count on the indoor cashmemo tab.
  fastify.get("/cashmemo/ipd-admitted-patients", ipdAdmittedPatientsQuerySchema, async (req, reply) => {
    try {
      const startDate = parseInt(req.query.startDate);
      const endDate = parseInt(req.query.endDate);

      if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

      const patients = await ipdCol()
        .find(
          { labId: labId(req), admittedAt: { $gte: startDate, $lte: endDate } },
          {
            projection: {
              admissionId: 1,
              status: 1,
              patient: 1,
              space: 1,
              supervisorDoctor: 1,
              dealType: 1,
              admittedAt: 1,
            },
          },
        )
        .sort({ admittedAt: -1 })
        .toArray();

      return reply.send({ patients });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch admitted patients" });
    }
  });

  // ── GET /cashmemo/ipd-released-patients ───────────────────────────────────
  // List of patients whose releasedAt falls within the date range, used to
  // drill into the "ছাড়প্রাপ্ত রোগী" count on the indoor cashmemo tab.
  fastify.get("/cashmemo/ipd-released-patients", ipdReleasedPatientsQuerySchema, async (req, reply) => {
    try {
      const startDate = parseInt(req.query.startDate);
      const endDate = parseInt(req.query.endDate);

      if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

      const patients = await ipdCol()
        .find(
          { labId: labId(req), releasedAt: { $gte: startDate, $lte: endDate } },
          {
            projection: {
              admissionId: 1,
              status: 1,
              patient: 1,
              space: 1,
              supervisorDoctor: 1,
              dealType: 1,
              admittedAt: 1,
              releasedAt: 1,
            },
          },
        )
        .sort({ releasedAt: -1 })
        .toArray();

      return reply.send({ patients });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch released patients" });
    }
  });

  // ── GET /cashmemo/expense-summary ─────────────────────────────────────────
  // Total lab operational expense (staffSalary/medicine/testKit/products/others)
  // for a date range — sourced from the `expenses` collection, active only.
  fastify.get("/cashmemo/expense-summary", expenseSummaryQuerySchema, async (req, reply) => {
    try {
      const startDate = parseInt(req.query.startDate);
      const endDate = parseInt(req.query.endDate);

      if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

      const [result] = await expenseCol()
        .aggregate(
          [
            {
              $match: {
                labId: labId(req),
                "deletion.status": false,
                createdAt: { $gte: startDate, $lte: endDate },
              },
            },
            {
              $group: {
                _id: null,
                totalExpense: { $sum: "$amount" },
                expenseCount: { $sum: 1 },
              },
            },
            { $project: { _id: 0, totalExpense: 1, expenseCount: 1 } },
          ],
          { allowDiskUse: true },
        )
        .toArray();

      return reply.send({
        totalExpense: Math.round(result?.totalExpense ?? 0),
        expenseCount: result?.expenseCount ?? 0,
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch expense summary" });
    }
  });
}

export default cashmemoRoutes;
