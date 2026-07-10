import toObjectId from "../../utils/db.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────
const getNestedField = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);

const buildCursorFilter = ({ cursor, startDate, endDate, field = "createdAt" }) => {
  const range = {};
  if (startDate) range.$gte = startDate;
  if (endDate) range.$lte = endDate;
  if (cursor) range.$lt = endDate ? Math.min(cursor, endDate) : cursor;
  return Object.keys(range).length ? { [field]: range } : {};
};

const parsePaginationQuery = (query) => ({
  limit: Math.min(parseInt(query.limit) || 20, 100),
  cursor: query.cursor ? parseInt(query.cursor) : null,
  startDate: query.startDate ? parseInt(query.startDate) : null,
  endDate: query.endDate ? parseInt(query.endDate) : null,
});

const buildAmountFilter = ({ minAmount, maxAmount }) => {
  const range = {};
  if (minAmount !== undefined && minAmount !== null && minAmount !== "") range.$gte = Number(minAmount);
  if (maxAmount !== undefined && maxAmount !== null && maxAmount !== "") range.$lte = Number(maxAmount);
  return Object.keys(range).length ? { amount: range } : {};
};

const paginatedResponse = (result, limit, cursorField) => {
  const hasMore = result.length > limit;
  if (hasMore) result.pop();
  return {
    expenses: result,
    nextCursor: hasMore ? getNestedField(result.at(-1), cursorField) : null,
    hasMore,
  };
};

// ─── Reusable Schema Definitions ─────────────────────────────────────────────

const EXPENSE_TYPES = ["staffSalary", "medicine", "testKit", "products", "others"];

const expenseIdParamSchema = {
  type: "object",
  required: ["expenseId"],
  properties: {
    expenseId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the expense" },
  },
};

const paginationQuerySchema = {
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Number of results per page (max 100)" },
    cursor: { type: "integer", minimum: 0, description: "Timestamp cursor for pagination" },
    startDate: { type: "integer", minimum: 0, description: "Filter start date as Unix timestamp (ms)" },
    endDate: { type: "integer", minimum: 0, description: "Filter end date as Unix timestamp (ms)" },
    type: { type: "string", enum: EXPENSE_TYPES, description: "Filter by expense type" },
    minAmount: { type: "number", minimum: 0, description: "Filter by minimum amount" },
    maxAmount: { type: "number", minimum: 0, description: "Filter by maximum amount" },
  },
};

// ─── Schemas ──────────────────────────────────────────────────────────────────

const addExpenseSchema = {
  schema: {
    tags: ["Expenses"],
    summary: "Create a new expense",
    body: {
      type: "object",
      required: ["type", "amount"],
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: EXPENSE_TYPES, description: "Category of the expense" },
        description: { type: "string", maxLength: 1000, description: "Optional description of the expense" },
        amount: { type: "number", minimum: 0, maximum: 10000000, description: "Expense amount" },
      },
    },
  },
};

const editExpenseSchema = {
  schema: {
    tags: ["Expenses"],
    summary: "Edit an expense's description (amount and type are immutable)",
    params: expenseIdParamSchema,
    body: {
      type: "object",
      required: ["description"],
      additionalProperties: false,
      properties: {
        description: { type: "string", maxLength: 1000, description: "Updated description of the expense" },
      },
    },
  },
};

const expenseIdSchema = {
  schema: {
    tags: ["Expenses"],
    params: expenseIdParamSchema,
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

async function expenseRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("expenses");
  const labId = (req) => toObjectId(req.user.labId);
  const userId = (req) => toObjectId(req.user.id);

  fastify.addHook("onRequest", fastify.authenticate);

  const requireCreate = { onRequest: [fastify.authorize("addExpense")] };
  const requireDelete = { onRequest: [fastify.authorize("deleteExpense")] };
  const requireExpenseReport = { onRequest: [fastify.authorize("expenseReport")] };

  // ── POST /expense/add ─────────────────────────────────────────────────────
  fastify.post("/expense/add", { ...addExpenseSchema, ...requireCreate }, async (req, reply) => {
    try {
      const { type, description, amount } = req.body;

      // ── Billing guard ───────────────────────────────────────────────────
      const isBlocked = await fastify.checkBillingBlocked(labId(req));
      if (isBlocked) {
        return reply.code(402).send({
          error:
            "Your account has an overdue bill. Please clear your outstanding balance to continue creating expenses.",
        });
      }

      const doc = {
        labId: labId(req),
        type,
        description: description?.trim() ?? "",
        amount,
        createdAt: Date.now(),
        createdBy: {
          id: userId(req),
          name: req.user.name,
        },
        updated: {
          at: null,
          by: { id: null, name: null },
        },
        deletion: {
          status: false,
          at: null,
          by: { id: null, name: null },
        },
      };

      const result = await col().insertOne(doc);

      return reply.code(201).send({ success: true, expenseId: result.insertedId });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to create expense" });
    }
  });

  // ── PATCH /expense/:expenseId/edit ────────────────────────────────────────
  // Only description is editable — type and amount are immutable once created.
  // No permission gate: any authenticated staff (or admin) can edit.
  fastify.patch("/expense/:expenseId/edit", { ...editExpenseSchema }, async (req, reply) => {
    try {
      const { expenseId } = req.params;
      const { description } = req.body;

      const expense = await col().findOne(
        { _id: toObjectId(expenseId), labId: labId(req) },
        { projection: { "deletion.status": 1 } },
      );
      if (!expense) return reply.code(404).send({ error: "Expense not found" });
      if (expense.deletion.status) return reply.code(400).send({ error: "Cannot edit a deleted expense" });

      const update = {
        description: description.trim(),
        updated: {
          at: Date.now(),
          by: { id: userId(req), name: req.user.name },
        },
      };

      await col().updateOne({ _id: toObjectId(expenseId), labId: labId(req) }, { $set: update });
      return reply.send({ success: true, ...update });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update expense" });
    }
  });

  // ── PATCH /expense/:expenseId/delete ──────────────────────────────────────
  // Soft delete, consistent with invoices — keeps a recoverable audit trail.
  fastify.patch("/expense/:expenseId/delete", { ...expenseIdSchema, ...requireDelete }, async (req, reply) => {
    try {
      const { expenseId } = req.params;

      const expense = await col().findOne(
        { _id: toObjectId(expenseId), labId: labId(req) },
        { projection: { "deletion.status": 1 } },
      );
      if (!expense) return reply.code(404).send({ error: "Expense not found" });
      if (expense.deletion.status) return reply.code(400).send({ error: "Expense already deleted" });

      await col().updateOne(
        { _id: toObjectId(expenseId), labId: labId(req) },
        {
          $set: {
            deletion: {
              status: true,
              at: Date.now(),
              by: { id: userId(req), name: req.user.name },
            },
          },
        },
      );
      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to delete expense" });
    }
  });

  // ── GET /expense/all ──────────────────────────────────────────────────────
  fastify.get(
    "/expense/all",
    {
      ...requireExpenseReport,
      schema: {
        tags: ["Expenses"],
        summary: "Get paginated list of active expenses (optionally filtered by type / timeframe)",
        querystring: paginationQuerySchema,
      },
    },
    async (req, reply) => {
      try {
        const { limit, cursor, startDate, endDate } = parsePaginationQuery(req.query);
        const { type, minAmount, maxAmount } = req.query;

        const result = await col()
          .find(
            {
              labId: labId(req),
              "deletion.status": false,
              ...(type && { type }),
              ...buildCursorFilter({ cursor, startDate, endDate }),
              ...buildAmountFilter({ minAmount, maxAmount }),
            },
            {
              projection: {
                type: 1,
                description: 1,
                amount: 1,
                createdAt: 1,
                "createdBy.name": 1,
              },
            },
          )
          .sort({ createdAt: -1 })
          .limit(limit + 1)
          .toArray();

        return reply.send(paginatedResponse(result, limit, "createdAt"));
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch expenses" });
      }
    },
  );

  // ── GET /expense/deleted ───────────────────────────────────────────────────
  fastify.get(
    "/expense/deleted",
    {
      ...requireExpenseReport,
      schema: {
        tags: ["Expenses"],
        summary: "Get paginated list of soft-deleted expenses",
        querystring: paginationQuerySchema,
      },
    },
    async (req, reply) => {
      try {
        const { limit, cursor, startDate, endDate } = parsePaginationQuery(req.query);
        const { type, minAmount, maxAmount } = req.query;

        const result = await col()
          .find(
            {
              labId: labId(req),
              "deletion.status": true,
              ...(type && { type }),
              ...buildCursorFilter({ cursor, startDate, endDate, field: "deletion.at" }),
              ...buildAmountFilter({ minAmount, maxAmount }),
            },
            {
              projection: {
                type: 1,
                description: 1,
                amount: 1,
                createdAt: 1,
                "createdBy.name": 1,
                "deletion.at": 1,
                "deletion.by.name": 1,
              },
            },
          )
          .sort({ "deletion.at": -1 })
          .limit(limit + 1)
          .toArray();

        return reply.send(paginatedResponse(result, limit, "deletion.at"));
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch deleted expenses" });
      }
    },
  );

  // ── GET /expense/:expenseId ───────────────────────────────────────────────
  fastify.get("/expense/:expenseId", expenseIdSchema, async (req, reply) => {
    try {
      const expense = await col().findOne({
        _id: toObjectId(req.params.expenseId),
        labId: labId(req),
      });
      if (!expense) return reply.code(404).send({ error: "Expense not found" });
      return reply.send(expense);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch expense" });
    }
  });
}

export default expenseRoutes;
