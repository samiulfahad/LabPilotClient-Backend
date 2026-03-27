import toObjectId from "../../utils/db.js";

// ─── Reusable Schema Fragments ────────────────────────────────────────────────

const objectIdSchema = {
  type: "string",
  minLength: 24,
  maxLength: 24,
  description: "MongoDB ObjectId (24-character hex string)",
};

const testIdParamSchema = {
  type: "object",
  required: ["testId"],
  properties: {
    testId: { ...objectIdSchema, description: "ObjectId of the test" },
  },
};

const schemaIdParamSchema = {
  type: "object",
  required: ["schemaId"],
  properties: {
    schemaId: { ...objectIdSchema, description: "ObjectId of the schema" },
  },
};

// ─── Schemas ──────────────────────────────────────────────────────────────────

const getAllTestsSchema = {
  schema: {
    tags: ["Tests"],
    summary: "Get all tests for the lab",
    querystring: {
      type: "object",
      properties: {
        sortBy: {
          type: "string",
          enum: ["name", "categoryId"],
          description: "Field to sort by (default: name)",
        },
      },
    },
  },
};

const getCategoriesSchema = {
  schema: {
    tags: ["Tests"],
    summary: "Get all test categories",
  },
};

const getCatalogSchema = {
  schema: {
    tags: ["Tests"],
    summary: "Get all tests from the global test catalog",
  },
};

const getTestSchemaByTestIdSchema = {
  schema: {
    tags: ["Tests"],
    summary: "Get active report schemas for a test",
    params: testIdParamSchema,
  },
};

const getTestByIdSchema = {
  schema: {
    tags: ["Tests"],
    summary: "Get a single test by ID",
    params: testIdParamSchema,
  },
};

const getSchemaByIdSchema = {
  schema: {
    tags: ["Schemas"],
    summary: "Get a report schema by ID",
    params: schemaIdParamSchema,
  },
};

const createTestSchema = {
  schema: {
    tags: ["Tests"],
    summary: "Create a new test for the lab",
    body: {
      type: "object",
      required: ["name", "testId"],
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
          minLength: 2,
          maxLength: 500,
          pattern: "^[a-zA-Z0-9\\s\\-_().]+$",
          description: "Name of the test",
        },
        testId: {
          ...objectIdSchema,
          description: "ObjectId of the global catalog test",
        },
        categoryId: {
          ...objectIdSchema,
          nullable: true,
          description: "ObjectId of the test category (optional)",
        },
        schemaId: {
          ...objectIdSchema,
          nullable: true,
          description: "ObjectId of the report schema (optional)",
        },
        price: {
          type: "number",
          minimum: 0,
          maximum: 1000000,
          multipleOf: 0.01,
          description: "Price of the test (max 2 decimal places)",
        },
      },
    },
  },
};

const updateTestSchema = {
  schema: {
    tags: ["Tests"],
    summary: "Update price or schema of a test",
    params: testIdParamSchema,
    body: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      description: "At least one of price or schemaId must be provided",
      properties: {
        price: {
          type: "number",
          minimum: 0,
          maximum: 1000000,
          multipleOf: 0.01,
          description: "Updated price (max 2 decimal places)",
        },
        schemaId: {
          type: ["string", "null"],
          minLength: 24,
          maxLength: 24,
          description: "Updated report schema ObjectId or null to unset",
        },
      },
    },
  },
};

const deleteTestSchema = {
  schema: {
    tags: ["Tests"],
    summary: "Hard delete a test",
    params: testIdParamSchema,
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

async function testRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("tests");
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);

  // ── GET /test/all ─────────────────────────────────────────────────────────
  fastify.get("/test/all", getAllTestsSchema, async (req, reply) => {
    try {
      const validSortFields = ["name", "categoryId"];
      const sortField = validSortFields.includes(req.query.sortBy) ? req.query.sortBy : "name";

      const tests = await col()
        .find({ labId: labId(req) })
        .sort({ [sortField]: 1 })
        .toArray();

      return reply.send(tests);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch tests" });
    }
  });

  // ── GET /test/categories ──────────────────────────────────────────────────
  fastify.get("/test/categories", getCategoriesSchema, async (req, reply) => {
    try {
      const list = await fastify.mongo.db.collection("testCategories").find({}).toArray();
      return reply.send(list);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch test categories" });
    }
  });

  // ── GET /test/catalog ─────────────────────────────────────────────────────
  fastify.get("/test/catalog", getCatalogSchema, async (req, reply) => {
    try {
      const list = await fastify.mongo.db.collection("testCatalog").find({}).toArray();
      return reply.send(list);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch test catalog" });
    }
  });

  // ── GET /test/schema/:testId ──────────────────────────────────────────────
  fastify.get("/test/schema/:testId", getTestSchemaByTestIdSchema, async (req, reply) => {
    try {
      const testId = toObjectId(req.params.testId);
      if (!testId) return reply.code(400).send({ error: "Invalid test ID" });

      const list = await fastify.mongo.db.collection("testSchemas").find({ testId, isActive: true }).toArray();
      return reply.send(list);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch test schemas" });
    }
  });

  // ── GET /test/:testId ─────────────────────────────────────────────────────
  fastify.get("/test/:testId", getTestByIdSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.testId);
      if (!_id) return reply.code(400).send({ error: "Invalid test ID" });

      const test = await col().findOne({ _id, labId: labId(req) });
      if (!test) return reply.code(404).send({ error: "Test not found" });
      return reply.send(test);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch test" });
    }
  });

  // ── GET /schema/:schemaId ─────────────────────────────────────────────────
  fastify.get("/schema/:schemaId", getSchemaByIdSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.schemaId);
      if (!_id) return reply.code(400).send({ error: "Invalid schema ID" });

      const schema = await fastify.mongo.db.collection("testSchemas").findOne({ _id });
      if (!schema) return reply.code(404).send({ error: "Schema not found" });
      return reply.send(schema);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch schema" });
    }
  });

  // ── POST /test ────────────────────────────────────────────────────────────
  fastify.post("/test", createTestSchema, async (req, reply) => {
    try {
      const { name, testId, categoryId, schemaId, price } = req.body;

      const existing = await col().findOne({ labId: labId(req), testId });
      if (existing) return reply.code(409).send({ error: "Test already registered" });

      const doc = {
        labId: labId(req),
        name: name.trim(),
        testId, // ← plain string reference to catalog _id
        categoryId: categoryId ? toObjectId(categoryId) : null,
        schemaId: schemaId ? toObjectId(schemaId) : null,
        price: price ?? 0,
        createdAt: Date.now(),
      };

      const result = await col().insertOne(doc);
      return reply.code(201).send({ _id: result.insertedId, ...doc });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to create test" });
    }
  });

  // ── PATCH /test/:testId ───────────────────────────────────────────────────
  fastify.patch("/test/:testId", updateTestSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.testId);
      if (!_id) return reply.code(400).send({ error: "Invalid test ID" });

      const { price, schemaId } = req.body;

      const update = {};
      if (price !== undefined) update.price = price;
      if (schemaId !== undefined) update.schemaId = schemaId ? toObjectId(schemaId) : null;
      update.updated = { at: Date.now(), by: { id: req.user.id, name: req.user.name } };

      const result = await col().updateOne({ _id, labId: labId(req) }, { $set: update });
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Test not found" });

      const updated = await col().findOne({ _id, labId: labId(req) });
      return reply.send(updated);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update test" });
    }
  });

  // ── DELETE /test/:testId ──────────────────────────────────────────────────
  fastify.delete("/test/:testId", deleteTestSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.testId);
      if (!_id) return reply.code(400).send({ error: "Invalid test ID" });

      const result = await col().deleteOne({ _id, labId: labId(req) });
      if (result.deletedCount === 0) return reply.code(404).send({ error: "Test not found" });
      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to delete test" });
    }
  });
}

export default testRoutes;
