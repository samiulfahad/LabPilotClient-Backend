// routes/expenseReportRoutes.js
import toObjectId from "../../utils/db.js";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const expenseSummaryQuerySchema = {
  schema: {
    tags: ["Test Stats"],
    summary: "Get expense totals grouped by type for a date range",
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

async function expenseReportRoutes(fastify) {
  const expensesCol = () => fastify.mongo.db.collection("expenses");
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("onRequest", fastify.authorize("expenseReport"));

  // ── GET /expense/summary ────────────────────────────────────────────────────
  // Grouped totals per expense type for a date range — powers the Expense tab.
  // Applies to both lab types (operational expense isn't gated by IPD).
  fastify.get("/expense/summary", expenseSummaryQuerySchema, async (req, reply) => {
    try {
      const startDate = parseInt(req.query.startDate);
      const endDate = parseInt(req.query.endDate);

      if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

      const result = await expensesCol()
        .aggregate([
          {
            $match: {
              labId: labId(req),
              createdAt: { $gte: startDate, $lte: endDate },
              "deletion.status": false,
            },
          },
          {
            $group: {
              _id: "$type",
              total: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ])
        .toArray();

      // Built entirely from whatever types show up in the aggregation — no hardcoded
      // list here, so new expense types (added in routes/expense.js) show up
      // automatically without needing an update in this file.
      const byType = {};
      result.forEach((r) => {
        byType[r._id] = { total: r.total, count: r.count };
      });

      const grandTotal = Object.values(byType).reduce((sum, v) => sum + v.total, 0);
      const totalEntries = Object.values(byType).reduce((sum, v) => sum + v.count, 0);

      return reply.send({ byType, grandTotal, totalEntries });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch expense summary" });
    }
  });
}

export default expenseReportRoutes;
