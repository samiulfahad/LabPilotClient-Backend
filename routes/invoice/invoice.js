import { ObjectId } from "mongodb";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const generateInvoiceId = () => {
  const pick = (pool) => {
    const arr = pool.split("");
    let out = "";
    for (let i = 0; i < (pool === "123456789" ? 4 : 3); i++) {
      const idx = Math.floor(Math.random() * arr.length);
      out += arr.splice(idx, 1)[0];
    }
    return out;
  };
  return pick("ABCDEFGHIJKLMNPQRSTUVWXYZ") + pick("123456789");
};

const buildCursorFilter = ({ cursor, startDate, endDate, field = "createdAt" }) => {
  const range = {};
  if (startDate) range.$gte = startDate;
  if (endDate) range.$lte = endDate;
  if (cursor) range.$lt = cursor;
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
    nextCursor: hasMore ? result.at(-1)[cursorField] : null,
    hasMore,
  };
};

// ─── Schemas ──────────────────────────────────────────────────────────────────

const invoiceIdSchema = {
  schema: {
    params: {
      type: "object",
      required: ["invoiceId"],
      properties: {
        invoiceId: {
          type: "string",
          pattern: "^[A-Z]{3}[1-9]{4}$",
          minLength: 7,
          maxLength: 7,
        },
      },
    },
  },
};

const addInvoiceSchema = {
  schema: {
    body: {
      type: "object",
      required: ["patient", "tests", "amount"],
      properties: {
        patient: {
          type: "object",
          required: ["name", "gender", "age", "contactNumber"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            gender: { type: "string", enum: ["male", "female"] },
            age: { type: "number", minimum: 0, maximum: 150 },
            contactNumber: { type: "string", minLength: 1, maxLength: 15 },
          },
        },
        referrer: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: ["string", "null"], maxLength: 24 },
            name: { type: ["string", "null"], maxLength: 150 },
            type: { type: ["string", "null"], maxLength: 50 },
          },
        },
        tests: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            required: ["testId", "name", "price"],
            additionalProperties: false,
            properties: {
              testId: { type: "string", minLength: 1, maxLength: 24 },
              name: { type: "string", minLength: 1, maxLength: 100 },
              price: { type: "number", minimum: 0, maximum: 1000000 },
              schemaId: { type: ["string", "null"], maxLength: 24 },
            },
          },
        },
        amount: {
          type: "object",
          required: ["initial", "referrerDiscount", "referrerCommission", "labAdjustment", "final", "net", "paid"],
          additionalProperties: false,
          properties: {
            initial: { type: "number", minimum: 0, maximum: 10000000 },
            referrerDiscount: { type: "number", minimum: 0, maximum: 10000000 },
            referrerCommission: { type: "number", minimum: 0, maximum: 10000000 },
            labAdjustment: { type: "number", minimum: 0, maximum: 10000000 },
            final: { type: "number", minimum: 0, maximum: 10000000 },
            net: { type: "number", minimum: 0, maximum: 10000000 },
            paid: { type: "number", minimum: 0, maximum: 10000000 },
          },
        },
      },
    },
  },
};

const patientInfoSchema = {
  schema: {
    body: {
      type: "object",
      required: ["patient"],
      properties: {
        patient: {
          type: "object",
          required: ["name", "gender", "age", "contactNumber"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            gender: { type: "string", enum: ["male", "female"] },
            age: { type: "number", minimum: 0, maximum: 150 },
            contactNumber: { type: "string", minLength: 1, maxLength: 15 },
          },
        },
      },
    },
  },
};

const invoiceIdWithPatientInfoSchema = {
  schema: {
    params: invoiceIdSchema.schema.params,
    body: patientInfoSchema.schema.body,
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

async function routes(fastify) {
  const col = () => fastify.mongo.db.collection("invoices");
  const labOId = (req) => new ObjectId(req.user.labOId);

  // ── All routes in this plugin require authentication ──────────────────────
  fastify.addHook("onRequest", fastify.authenticate);

  // Permission-only hooks (authenticate already handled by the hook above)
  const requireCreate = { onRequest: [fastify.authorize("createInvoice")] };
  const requireDelete = { onRequest: [fastify.authorize("deleteInvoice")] };

  // ── GET /invoice/required-data ────────────────────────────────────────────
  fastify.get("/invoice/required-data", async (req, reply) => {
    try {
      const [referrers, tests] = await Promise.all([
        fastify.mongo.db
          .collection("referrers")
          .find(
            { labOId: labOId(req), isActive: true },
            { projection: { name: 1, degree: 1, commissionType: 1, commissionValue: 1, type: 1 } },
          )
          .sort({ name: 1 })
          .toArray(),
        fastify.mongo.db
          .collection("myTestList")
          .find({ labOId: labOId(req) }, { projection: { _id: 0, name: 1, price: 1, testId: 1, schemaId: 1 } })
          .sort({ createdAt: -1 })
          .toArray(),
      ]);
      return { referrers, tests };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch required data" });
    }
  });

  // ── POST /invoice/add ─────────────────────────────────────────────────────
  fastify.post("/invoice/add", { ...addInvoiceSchema, ...requireCreate }, async (req, reply) => {
    try {
      const { patient, referrer, tests, amount } = req.body;

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
        labOId: labOId(req),
        invoiceId,
        createdAt: Date.now(),
        patient: {
          name: patient.name,
          gender: patient.gender,
          age: Number(patient.age),
          contactNumber: patient.contactNumber,
        },
        referrer: referrer ?? { id: null, name: null, type: null },
        tests: tests.map((t) => ({
          testId: new ObjectId(t.testId),
          name: t.name,
          price: t.price,
          schemaId: t.schemaId ? new ObjectId(t.schemaId) : null,
          ...(t.schemaId && { report: {}, isCompleted: false }),
        })),
        amount: {
          initial: Number(amount.initial) || 0,
          referrerDiscount: Number(amount.referrerDiscount) || 0,
          referrerCommission: Number(amount.referrerCommission) || 0,
          labAdjustment: Number(amount.labAdjustment) || 0,
          final: Number(amount.final) || 0,
          net: Number(amount.net) || 0,
          paid: Number(amount.paid) || 0,
        },
        isDelivered: false,
        isDeleted: false,
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

  // ── GET /invoice/all ──────────────────────────────────────────────────────
  fastify.get("/invoice/all", async (req, reply) => {
    try {
      const { limit, cursor, startDate, endDate } = parsePaginationQuery(req.query);
      const result = await col()
        .find(
          {
            labOId: labOId(req),
            isDeleted: false,
            ...buildCursorFilter({ cursor, startDate, endDate }),
          },
          {
            projection: {
              _id: 1,
              invoiceId: 1,
              createdAt: 1,
              isDelivered: 1,
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
  });

  // ── GET /invoice/deleted ──────────────────────────────────────────────────
  fastify.get("/invoice/deleted", async (req, reply) => {
    try {
      const { limit, cursor, startDate, endDate } = parsePaginationQuery(req.query);
      const result = await col()
        .find(
          {
            labOId: labOId(req),
            isDeleted: true,
            ...buildCursorFilter({ cursor, startDate, endDate, field: "deletedAt" }),
          },
          {
            projection: {
              _id: 1,
              invoiceId: 1,
              createdAt: 1,
              deletedAt: 1,
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
        .sort({ deletedAt: -1 })
        .limit(limit + 1)
        .toArray();
      return reply.send(paginatedResponse(result, limit, "deletedAt"));
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch deleted invoices" });
    }
  });

  // ── GET /invoice/:invoiceId ───────────────────────────────────────────────
  fastify.get("/invoice/:invoiceId", invoiceIdSchema, async (req, reply) => {
    try {
      const invoice = await col().findOne({
        invoiceId: req.params.invoiceId,
        labOId: labOId(req),
      });
      if (!invoice) return reply.code(404).send({ error: "Invoice not found" });
      return reply.send(invoice);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch invoice" });
    }
  });

  // ── GET /invoice/:invoiceId/report-summary ────────────────────────────────
  fastify.get("/invoice/:invoiceId/report-summary", invoiceIdSchema, async (req, reply) => {
    try {
      const invoice = await col().findOne(
        {
          invoiceId: req.params.invoiceId,
          labOId: labOId(req),
        },
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
  });

  // ── PATCH /invoice/:invoiceId/patient-info ────────────────────────────────
  fastify.patch("/invoice/:invoiceId/patient-info", invoiceIdWithPatientInfoSchema, async (req, reply) => {
    try {
      const { invoiceId } = req.params;
      const { patient } = req.body;

      if (!(await col().findOne({ invoiceId, labOId: labOId(req) }, { projection: { _id: 1 } })))
        return reply.code(404).send({ error: "Invoice not found" });

      const update = {
        patient: {
          name: patient.name.trim(),
          gender: patient.gender,
          age: Number(patient.age),
          contactNumber: patient.contactNumber.trim(),
        },
      };

      await col().updateOne({ invoiceId, labOId: labOId(req) }, { $set: update });
      return reply.send({ success: true, ...update });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update patient info" });
    }
  });

  // ── PATCH /invoice/:invoiceId/collect-due ─────────────────────────────────
  fastify.patch("/invoice/:invoiceId/collect-due", invoiceIdSchema, async (req, reply) => {
    try {
      const { invoiceId } = req.params;
      const invoice = await col().findOne({ invoiceId, labOId: labOId(req) }, { projection: { "amount.final": 1 } });
      if (!invoice) return reply.code(404).send({ error: "Invoice not found" });

      const result = await col().updateOne(
        { invoiceId, labOId: labOId(req) },
        { $set: { "amount.paid": invoice.amount.final } },
      );
      if (result.modifiedCount === 0) return reply.code(400).send({ error: "Nothing to update" });

      return reply.send({ success: true, paid: invoice.amount.final });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to collect due amount" });
    }
  });

  // ── PATCH /invoice/:invoiceId/mark-delivered ──────────────────────────────
  fastify.patch("/invoice/:invoiceId/mark-delivered", invoiceIdSchema, async (req, reply) => {
    try {
      const { invoiceId } = req.params;
      const invoice = await col().findOne({ invoiceId, labOId: labOId(req) }, { projection: { isDelivered: 1 } });
      if (!invoice) return reply.code(404).send({ error: "Invoice not found" });
      if (invoice.isDelivered) return reply.code(400).send({ error: "Invoice is already marked as delivered" });

      await col().updateOne({ invoiceId, labOId: labOId(req) }, { $set: { isDelivered: true } });
      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to mark invoice as delivered" });
    }
  });

  // ── PATCH /invoice/:invoiceId/delete ──────────────────────────────────────
  fastify.patch("/invoice/:invoiceId/delete", { ...invoiceIdSchema, ...requireDelete }, async (req, reply) => {
    try {
      const { invoiceId } = req.params;
      const invoice = await col().findOne({ invoiceId, labOId: labOId(req) }, { projection: { isDeleted: 1 } });
      if (!invoice) return reply.code(404).send({ error: "Invoice not found" });
      if (invoice.isDeleted) return reply.code(400).send({ error: "Invoice is already deleted" });

      await col().updateOne({ invoiceId, labOId: labOId(req) }, { $set: { isDeleted: true, deletedAt: Date.now() } });
      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to delete invoice" });
    }
  });
}

export default routes;
