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
  fastify.get("/test/all", async (req, reply) => {
    try {
      const tests = await collection.find({}).sort({ createdAt: -1 }).toArray();
      return tests.map(toClientFormat);
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch tests" });
    }
  });

  // GET single test
  fastify.get("/test/:testId", async (req, reply) => {
    try {
      const { testId } = req.params;

      if (!ObjectId.isValid(testId)) {
        return reply.code(400).send({ error: "Invalid test ID format" });
      }

      const test = await collection.findOne({ testId: testId });

      if (!test) {
        return reply.code(404).send({ error: "Test not found" });
      }

      return toClientFormat(test);
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch test" });
    }
  });

  // POST - Create Test
  fastify.post("/test", async (req, reply) => {
    try {
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

      return reply.code(201).send({
        _id: result.insertedId.toString(),
        ...newTest,
      });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to create test" });
    }
  });

  // PATCH - Update Test
  fastify.patch("/test/:testId", async (req, reply) => {
    try {
      const { testId } = req.params;
      const { price, schemaId } = req.body;

      if (!ObjectId.isValid(testId)) {
        return reply.code(400).send({ error: "Invalid test ID format" });
      }

      // Check if at least one field is provided
      if (price === undefined && schemaId === undefined) {
        return reply.code(400).send({ error: "At least one field (price or schemaId) is required" });
      }

      const updateData = {
        updatedAt: new Date(),
      };

      // Validate and add price if provided
      if (price !== undefined && price !== null) {
        const parsedPrice = parseFloat(price);
        if (isNaN(parsedPrice) || parsedPrice < 0) {
          return reply.code(400).send({ error: "Invalid price value" });
        }
        updateData.price = parsedPrice;
      }

      // Add schemaId if provided (can be null or empty)
      if (schemaId !== undefined) {
        updateData.schemaId = schemaId || null;
      }

      const result = await collection.updateOne({ testId: testId }, { $set: updateData });

      if (result.matchedCount === 0) {
        return reply.code(404).send({ error: "Test not found" });
      }

      const updated = await collection.findOne({ testId: testId });
      return toClientFormat(updated);
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to update test" });
    }
  });

  // DELETE - Hard Delete
  fastify.delete("/test/:testId", async (req, reply) => {
    try {
      const { testId } = req.params;

      if (!ObjectId.isValid(testId)) {
        return reply.code(400).send({ error: "Invalid test ID format" });
      }

      const result = await collection.deleteOne({ testId: testId });

      if (result.deletedCount === 0) {
        return reply.code(404).send({ error: "Test not found" });
      }

      return { message: "Test deleted successfully" };
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to delete test" });
    }
  });

  // GET All Test Categories
  fastify.get("/test/categories", async (req, reply) => {
    try {
      const list = await fastify.mongo.db.collection("testCategory").find({}).toArray();
      return reply.code(200).send(list);
    } catch (error) {
      return reply.code(500).send({ error: "Failed to fetch test categories" });
    }
  });

  // GET All Test Categories
  fastify.get("/test/catalog", async (req, reply) => {
    try {
      const list = await fastify.mongo.db.collection("testCatalog").find({}).toArray();
      return reply.code(200).send(list);
    } catch (error) {
      return reply.code(500).send({ error: "Failed to fetch test categories" });
    }
  });

  // GET Active Test Schema only by Test ID
  fastify.get("/test/schema/:testId", async (req, reply) => {
    try {
      const { testId } = req.params;

      if (!ObjectId.isValid(testId)) {
        return reply.code(400).send({ error: "Invalid test ID format" });
      }

      const list = await fastify.mongo.db.collection("testSchema").find({ testId, isActive: true }).toArray();
      return reply.code(200).send(list);
    } catch (error) {
      return reply.code(500).send({ error: "Failed to fetch test formats" });
    }
  });
}

export default routes;
