import toObjectId from "../../utils/db.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const generateInvoiceId = () => {
  const pick = (pool, count) => {
    const arr = pool.split("");
    let out = "";
    for (let i = 0; i < count; i++) {
      const idx = Math.floor(Math.random() * arr.length);
      out += arr.splice(idx, 1)[0];
    }
    return out;
  };
  return pick("ABCDEFGHIJKLMNPQRSTUVWXYZ", 3) + pick("123456789", 4);
};

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

const paginatedResponse = (result, limit, cursorField) => {
  const hasMore = result.length > limit;
  if (hasMore) result.pop();
  return {
    invoices: result,
    nextCursor: hasMore ? getNestedField(result.at(-1), cursorField) : null,
    hasMore,
  };
};

// ─── Reusable Schema Definitions ─────────────────────────────────────────────

const patientBodySchema = {
  type: "object",
  required: ["name", "gender", "age", "contactNumber"],
  additionalProperties: false,
  description: "Patient details",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100, description: "Full name of the patient" },
    gender: { type: "string", enum: ["male", "female"], description: "Gender of the patient" },
    age: { type: "integer", minimum: 0, maximum: 150, description: "Age of the patient in years" },
    contactNumber: { type: "string", minLength: 1, maxLength: 15, description: "Contact number of the patient" },
  },
};

const invoiceIdParamSchema = {
  type: "object",
  required: ["invoiceId"],
  properties: {
    invoiceId: {
      type: "string",
      pattern: "^[A-NP-Z]{3}[1-9]{4}$",
      minLength: 7,
      maxLength: 7,
      description: "Unique invoice ID (3 uppercase letters excluding O + 4 non-zero digits)",
    },
  },
};

const paginationQuerySchema = {
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Number of results per page (max 100)" },
    cursor: { type: "integer", minimum: 0, description: "Timestamp cursor for pagination" },
    startDate: { type: "integer", minimum: 0, description: "Filter start date as Unix timestamp (ms)" },
    endDate: { type: "integer", minimum: 0, description: "Filter end date as Unix timestamp (ms)" },
  },
};

// ─── Schemas ──────────────────────────────────────────────────────────────────

const invoiceIdSchema = {
  schema: {
    tags: ["Invoices"],
    params: invoiceIdParamSchema,
  },
};

const addInvoiceSchema = {
  schema: {
    tags: ["Invoices"],
    summary: "Create a new invoice",
    body: {
      type: "object",
      required: ["patient", "tests", "amount"],
      additionalProperties: false,
      properties: {
        patient: patientBodySchema,
        referrer: {
          type: "object",
          additionalProperties: false,
          description: "Referring doctor or entity (optional)",
          properties: {
            id: { type: ["string", "null"], minLength: 24, maxLength: 24, description: "ObjectId of the referrer" },
            name: { type: ["string", "null"], maxLength: 150, description: "Name of the referrer" },
            type: { type: ["string", "null"], maxLength: 50, description: "Type of referrer e.g. doctor, clinic" },
          },
        },
        tests: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          description: "List of tests included in the invoice",
          items: {
            type: "object",
            required: ["testId", "name", "price"],
            additionalProperties: false,
            properties: {
              testId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the test" },
              name: { type: "string", minLength: 1, maxLength: 100, description: "Name of the test" },
              price: { type: "number", minimum: 0, maximum: 10000000, description: "Price of the test" },
              schemaId: {
                type: ["string", "null"],
                minLength: 24,
                maxLength: 24,
                description: "ObjectId of the report schema (if any)",
              },
            },
          },
        },
        amount: {
          type: "object",
          required: ["initial", "referrerDiscount", "referrerCommission", "labAdjustment", "final", "net", "paid"],
          additionalProperties: false,
          description: "Invoice amount breakdown",
          properties: {
            initial: {
              type: "number",
              minimum: 0,
              maximum: 10000000,
              description: "Sum of all test prices before adjustments",
            },
            referrerDiscount: {
              type: "number",
              minimum: 0,
              maximum: 10000000,
              description: "Discount given to patient via referrer",
            },
            referrerCommission: {
              type: "number",
              minimum: 0,
              maximum: 10000000,
              description: "Commission owed to referrer",
            },
            labAdjustment: {
              type: "number",
              minimum: 0,
              maximum: 10000000,
              description: "Additional lab-side adjustment",
            },
            final: { type: "number", minimum: 0, maximum: 10000000, description: "Final amount payable by patient" },
            net: {
              type: "number",
              minimum: 0,
              maximum: 10000000,
              description: "Net amount earned by lab after deductions",
            },
            paid: {
              type: "number",
              minimum: 0,
              maximum: 10000000,
              description: "Amount paid at time of invoice creation",
            },
          },
        },
      },
    },
  },
};

const patientInfoSchema = {
  schema: {
    tags: ["Invoices"],
    summary: "Update patient info on an invoice",
    params: invoiceIdParamSchema,
    body: {
      type: "object",
      required: ["patient"],
      additionalProperties: false,
      properties: {
        patient: patientBodySchema,
      },
    },
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

async function invoiceRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("invoices");
  const labId = (req) => toObjectId(req.user.labId);
  const userId = (req) => toObjectId(req.user.id); // ← helper to avoid repetition

  fastify.addHook("onRequest", fastify.authenticate);

  const requireCreate = { onRequest: [fastify.authorize("createInvoice")] };
  const requireDelete = { onRequest: [fastify.authorize("deleteInvoice")] };

  // ── GET /invoice/required-data ────────────────────────────────────────────
  fastify.get(
    "/invoice/required-data",
    {
      schema: {
        tags: ["Invoices"],
        summary: "Fetch referrers and tests needed to create an invoice",
      },
    },
    async (req, reply) => {
      try {
        const [referrers, tests] = await Promise.all([
          fastify.mongo.db
            .collection("referrers")
            .find(
              { labId: labId(req), isActive: true },
              { projection: { name: 1, degree: 1, commissionType: 1, commissionValue: 1, type: 1 } },
            )
            .sort({ name: 1 })
            .toArray(),
          fastify.mongo.db
            .collection("tests")
            .find({ labId: labId(req) }, { projection: { _id: 0, name: 1, price: 1, testId: 1, schemaId: 1 } })
            .sort({ createdAt: -1 })
            .toArray(),
        ]);
        return reply.send({ referrers, tests });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch required data" });
      }
    },
  );

  // ── POST /invoice/add ─────────────────────────────────────────────────────
  fastify.post("/invoice/add", { ...addInvoiceSchema, ...requireCreate }, async (req, reply) => {
    try {
      const { patient, referrer, tests, amount } = req.body;

      if (amount.paid > amount.final) return reply.code(400).send({ error: "Paid amount cannot exceed final amount" });

      let invoiceId;
      for (let i = 0; i < 5; i++) {
        const candidate = generateInvoiceId();
        if (!(await col().findOne({ invoiceId: candidate }, { projection: { _id: 1 } }))) {
          invoiceId = candidate;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      if (!invoiceId)
        return reply.code(500).send({ error: "Failed to generate a unique invoice ID, please try again" });

      await col().insertOne({
        labId: labId(req),
        labKey: req.user.labKey,
        invoiceId,
        createdAt: Date.now(),
        patient: {
          name: patient.name,
          gender: patient.gender,
          age: patient.age,
          contactNumber: patient.contactNumber,
        },
        referrer: referrer
          ? {
              id: referrer.id ? toObjectId(referrer.id) : null,
              name: referrer.name ?? null,
              type: referrer.type ?? null,
            }
          : { id: null, name: null, type: null },
        tests: tests.map((t) => ({
          testId: toObjectId(t.testId),
          name: t.name,
          price: t.price,
          schemaId: t.schemaId ? toObjectId(t.schemaId) : null,
          ...(t.schemaId && { report: {}, isCompleted: false }),
        })),
        amount: {
          initial: amount.initial,
          referrerDiscount: amount.referrerDiscount,
          referrerCommission: amount.referrerCommission,
          labAdjustment: amount.labAdjustment,
          final: amount.final,
          net: amount.net,
          paid: amount.paid,
        },
        createdBy: {
          id: userId(req), // ← fixed
          name: req.user.name,
        },
        delivery: {
          status: false,
          by: { id: userId(req), name: req.user.name }, // ← fixed
        },
        collections: [
          {
            by: { id: userId(req), name: req.user.name }, // ← fixed
            amount: amount.paid,
            at: Date.now(),
          },
        ],
        deletion: {
          status: false,
          at: null,
          by: { id: null, name: null },
        },
      });

      return reply.code(201).send({
        invoiceId,
        link: `https://labpilotpro.com/${invoiceId}`,
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to create invoice" });
    }
  });

  // ── PATCH /invoice/:invoiceId/collect-due ─────────────────────────────────
  fastify.patch(
    "/invoice/:invoiceId/collect-due",
    {
      schema: {
        tags: ["Invoices"],
        summary: "Collect the remaining due amount on an invoice",
        params: invoiceIdParamSchema,
      },
    },
    async (req, reply) => {
      try {
        const { invoiceId } = req.params;

        const invoice = await col().findOne(
          { invoiceId, labId: labId(req) },
          { projection: { "amount.final": 1, "amount.paid": 1 } },
        );
        if (!invoice) return reply.code(404).send({ error: "Invoice not found" });

        const due = invoice.amount.final - invoice.amount.paid;
        if (due <= 0) return reply.code(400).send({ error: "Invoice already fully paid" });

        const result = await col().updateOne(
          { invoiceId, labId: labId(req) },
          {
            $set: { "amount.paid": invoice.amount.final },
            $push: {
              collections: {
                by: { id: userId(req), name: req.user.name }, // ← fixed
                amount: due,
                at: Date.now(),
              },
            },
          },
        );
        if (result.modifiedCount === 0) return reply.code(400).send({ error: "Nothing to update" });

        return reply.send({ success: true, paid: invoice.amount.final });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to collect due amount" });
      }
    },
  );

  // ── GET /invoice/all ──────────────────────────────────────────────────────
  fastify.get(
    "/invoice/all",
    {
      schema: {
        tags: ["Invoices"],
        summary: "Get paginated list of active invoices",
        querystring: paginationQuerySchema,
      },
    },
    async (req, reply) => {
      try {
        const { limit, cursor, startDate, endDate } = parsePaginationQuery(req.query);
        const result = await col()
          .find(
            {
              labId: labId(req),
              "deletion.status": false,
              ...buildCursorFilter({ cursor, startDate, endDate }),
            },
            {
              projection: {
                _id: 1,
                invoiceId: 1,
                createdAt: 1,
                "createdBy.name": 1,
                "delivery.status": 1,
                "patient.name": 1,
                "patient.gender": 1,
                "patient.age": 1,
                "patient.contactNumber": 1,
                "amount.final": 1,
                "amount.paid": 1,
                "tests.schemaId": 1,
              },
            },
          )
          .sort({ createdAt: -1 })
          .limit(limit + 1)
          .toArray();
        return reply.send(paginatedResponse(result, limit, "createdAt"));
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch invoices" });
      }
    },
  );

  // ── GET /invoice/deleted ──────────────────────────────────────────────────
  fastify.get(
    "/invoice/deleted",
    {
      schema: {
        tags: ["Invoices"],
        summary: "Get paginated list of deleted invoices",
        querystring: paginationQuerySchema,
      },
    },
    async (req, reply) => {
      try {
        const { limit, cursor, startDate, endDate } = parsePaginationQuery(req.query);
        const result = await col()
          .find(
            {
              labId: labId(req),
              "deletion.status": true,
              ...buildCursorFilter({ cursor, startDate, endDate, field: "deletion.at" }),
            },
            {
              projection: {
                _id: 1,
                invoiceId: 1,
                createdAt: 1,
                "deletion.by.name": 1,
                "deletion.at": 1,
                "patient.name": 1,
                "patient.gender": 1,
                "patient.age": 1,
                "patient.contactNumber": 1,
                "amount.final": 1,
                "amount.paid": 1,
                "tests.schemaId": 1,
              },
            },
          )
          .sort({ "deletion.at": -1 })
          .limit(limit + 1)
          .toArray();
        return reply.send(paginatedResponse(result, limit, "deletion.at"));
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch deleted invoices" });
      }
    },
  );

  // ── GET /invoice/:invoiceId ───────────────────────────────────────────────
  fastify.get(
    "/invoice/:invoiceId",
    {
      schema: {
        tags: ["Invoices"],
        summary: "Get full invoice by ID",
        params: invoiceIdParamSchema,
      },
    },
    async (req, reply) => {
      try {
        const invoice = await col().findOne({
          invoiceId: req.params.invoiceId,
          labId: labId(req),
        });
        if (!invoice) return reply.code(404).send({ error: "Invoice not found" });
        return reply.send(invoice);
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch invoice" });
      }
    },
  );

  // ── GET /invoice/:invoiceId/report-summary ────────────────────────────────
  fastify.get(
    "/invoice/:invoiceId/report-summary",
    {
      schema: {
        tags: ["Invoices"],
        summary: "Get invoice report summary for printing or sharing",
        params: invoiceIdParamSchema,
      },
    },
    async (req, reply) => {
      try {
        const invoice = await col().findOne(
          { invoiceId: req.params.invoiceId, labId: labId(req) },
          {
            projection: {
              _id: 0,
              invoiceId: 1,
              createdAt: 1,
              "patient.name": 1,
              "patient.gender": 1,
              "patient.age": 1,
              "patient.contactNumber": 1,
              "amount.initial": 1,
              "amount.final": 1,
              "amount.paid": 1,
              "tests.testId": 1,
              "tests.name": 1,
              "tests.price": 1,
              "tests.schemaId": 1,
              "tests.isCompleted": 1,
              "tests.report.sampleCollectionDate": 1,
              "tests.report.reportDate": 1,
            },
          },
        );
        if (!invoice) return reply.code(404).send({ error: "Invoice not found" });
        return reply.send(invoice);
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch invoice summary" });
      }
    },
  );

  // ── PATCH /invoice/:invoiceId/patient-info ────────────────────────────────
  fastify.patch("/invoice/:invoiceId/patient-info", patientInfoSchema, async (req, reply) => {
    try {
      const { invoiceId } = req.params;
      const { patient } = req.body;

      if (!(await col().findOne({ invoiceId, labId: labId(req) }, { projection: { _id: 1 } })))
        return reply.code(404).send({ error: "Invoice not found" });

      const update = {
        patient: {
          name: patient.name.trim(),
          gender: patient.gender,
          age: patient.age,
          contactNumber: patient.contactNumber.trim(),
        },
        updated: {
          at: Date.now(),
          by: { id: userId(req), name: req.user.name }, // ← fixed
        },
      };

      await col().updateOne({ invoiceId, labId: labId(req) }, { $set: update });
      return reply.send({ success: true, ...update });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update patient info" });
    }
  });

  // ── PATCH /invoice/:invoiceId/mark-delivered ──────────────────────────────
  fastify.patch(
    "/invoice/:invoiceId/mark-delivered",
    {
      schema: {
        tags: ["Invoices"],
        summary: "Mark an invoice as delivered",
        params: invoiceIdParamSchema,
      },
    },
    async (req, reply) => {
      try {
        const { invoiceId } = req.params;

        const invoice = await col().findOne({ invoiceId, labId: labId(req) }, { projection: { "delivery.status": 1 } });
        if (!invoice) return reply.code(404).send({ error: "Invoice not found" });
        if (invoice.delivery.status) return reply.code(400).send({ error: "Invoice already marked as delivered" });

        await col().updateOne(
          { invoiceId, labId: labId(req) },
          {
            $set: {
              delivery: {
                status: true,
                by: { id: userId(req), name: req.user.name }, // ← fixed
              },
            },
          },
        );
        return reply.send({ success: true });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to mark invoice as delivered" });
      }
    },
  );

  // ── PATCH /invoice/:invoiceId/delete ──────────────────────────────────────
  fastify.patch(
    "/invoice/:invoiceId/delete",
    {
      ...requireDelete,
      schema: {
        tags: ["Invoices"],
        summary: "Soft delete an invoice",
        params: invoiceIdParamSchema,
      },
    },
    async (req, reply) => {
      try {
        const { invoiceId } = req.params;

        const invoice = await col().findOne({ invoiceId, labId: labId(req) }, { projection: { "deletion.status": 1 } });
        if (!invoice) return reply.code(404).send({ error: "Invoice not found" });
        if (invoice.deletion.status) return reply.code(400).send({ error: "Invoice already deleted" });

        await col().updateOne(
          { invoiceId, labId: labId(req) },
          {
            $set: {
              deletion: {
                status: true,
                at: Date.now(),
                by: { id: userId(req), name: req.user.name }, // ← fixed
              },
            },
          },
        );
        return reply.send({ success: true });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to delete invoice" });
      }
    },
  );
}

export default invoiceRoutes;
