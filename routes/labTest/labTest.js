import { ObjectId } from "mongodb";

const collectionName = "myTestList";

async function routes(fastify, options) {
  const collection = fastify.mongo.db.collection(collectionName);

  // Helper to convert _id to string
  const toClientFormat = (doc) => {
    if (!doc) return null;
    return { ...doc, _id: doc._id.toString() };
  };

  // GET all tests
  fastify.get("/tests", async (req, reply) => {
    const tests = await collection.find({}).sort({ createdAt: -1 }).toArray();
    return tests.map(toClientFormat);
  });

  // GET single test
  fastify.get("/test/:testId", async (req, reply) => {
    const { testId } = req.params;

    if (!ObjectId.isValid(testId)) {
      reply.code(400).send({ error: "Invalid test ID format" });
      return;
    }

    const test = await collection.findOne({ testId: testId });

    if (!test) {
      reply.code(404).send({ error: "Test not found" });
      return;
    }

    return toClientFormat(test);
  });

  // POST - Create Test
  fastify.post("/test/add", async (req, reply) => {
    const { name, testId, categoryId, schemaId, price } = req.body;

    // Validation
    if (!name?.trim()) {
      return reply.code(400).send({ error: "Test name is required" });
    }

    // Check if test name already exists
    const existingTest = await collection.findOne({ name: name.trim() });
    if (existingTest) {
      return reply.code(400).send({ error: "Test name already exists" });
    }

    // Validate categoryId is a valid MongoDB ObjectId if provided
    if (categoryId && !ObjectId.isValid(categoryId)) {
      return reply.code(400).send({ error: "Invalid category ID format" });
    }

    // Validate testId is a valid MongoDB ObjectId if provided
    if (testId && !ObjectId.isValid(testId)) {
      return reply.code(400).send({ error: "Invalid test ID format" });
    }

    const newTest = {
      name: name.trim(),
      testId: testId || null,
      categoryId: categoryId || null,
      schemaId: schemaId || null,
      price: parseFloat(price) || 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await collection.insertOne(newTest);

    reply.code(201).send({
      _id: result.insertedId.toString(),
      ...newTest,
    });
  });

  // PATCH - Update Test Price
  fastify.patch("/test/:testId/update-price", async (req, reply) => {
    const { testId } = req.params;
    const { price } = req.body;

    if (!ObjectId.isValid(testId)) {
      reply.code(400).send({ error: "Invalid test ID format" });
      return;
    }

    // Validation
    if (price === undefined || price === null) {
      return reply.code(400).send({ error: "Price is required" });
    }

    const parsedPrice = parseFloat(price);
    if (isNaN(parsedPrice) || parsedPrice < 0) {
      return reply.code(400).send({ error: "Invalid price value" });
    }

    const updateData = {
      price: parsedPrice,
      updatedAt: new Date(),
    };

    const result = await collection.updateOne({ testId: testId }, { $set: updateData });

    if (result.matchedCount === 0) {
      reply.code(404).send({ error: "Test not found" });
      return;
    }

    const updated = await collection.findOne({ testId: testId });
    return toClientFormat(updated);
  });

  // PATCH - Update Test Schema
  fastify.patch("/test/:testId/update-schema", async (req, reply) => {
    const { testId } = req.params;
    const { schemaId } = req.body;

    if (!ObjectId.isValid(testId)) {
      reply.code(400).send({ error: "Invalid test ID format" });
      return;
    }

    const updateData = {
      schemaId: schemaId || null,
      updatedAt: new Date(),
    };

    const result = await collection.updateOne({ testId: testId }, { $set: updateData });

    if (result.matchedCount === 0) {
      reply.code(404).send({ error: "Test not found" });
      return;
    }

    const updated = await collection.findOne({ testId: testId });
    return toClientFormat(updated);
  });

  // DELETE - Hard Delete
  fastify.delete("/test/:testId", async (req, reply) => {
    const { testId } = req.params;

    if (!ObjectId.isValid(testId)) {
      reply.code(400).send({ error: "Invalid test ID format" });
      return;
    }

    const result = await collection.deleteOne({ testId: testId });

    if (result.deletedCount === 0) {
      reply.code(404).send({ error: "Test not found" });
      return;
    }

    return { message: "Test deleted successfully" };
  });
}

export default routes;