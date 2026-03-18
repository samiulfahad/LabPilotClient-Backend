import { ObjectId } from "mongodb";

const collectionName = "myTestList";

async function routes(fastify, options) {
  const collection = fastify.mongo.db.collection(collectionName);

  // GET all tests
  fastify.get("/test/all", async (req, reply) => {
    try {
      const { sortBy } = req.query;

      const validSortFields = ["name", "categoryId"];
      const sortField = validSortFields.includes(sortBy) ? sortBy : "name";

      const tests = await collection
        .find({})
        .sort({ [sortField]: 1 })
        .toArray();
      return tests;
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

      return test;
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch test" });
    }
  });

  // POST - Create Test
  fastify.post("/test", async (req, reply) => {
    try {
      const { name, testId, categoryId, schemaId, price } = req.body;

      // Validate body exists
      if (!req.body || typeof req.body !== "object") {
        return reply.code(400).send({ error: "Request body is required" });
      }

      // Validate name
      if (!name || typeof name !== "string" || !name.trim()) {
        return reply.code(400).send({ error: "Test name is required" });
      }
      if (name.trim().length < 2) {
        return reply.code(400).send({ error: "Test name must be at least 2 characters" });
      }
      if (name.trim().length > 500) {
        return reply.code(400).send({ error: "Test name must not exceed 500 characters" });
      }
      if (!/^[a-zA-Z0-9\s\-_().]+$/.test(name.trim())) {
        return reply.code(400).send({ error: "Test name contains invalid characters" });
      }

      // Check if test name already exists
      const existingTest = await collection.findOne({ name: name.trim() });
      if (existingTest) {
        return reply.code(400).send({ error: "Test name already exists" });
      }

      // Validate testId
      if (testId !== undefined && testId !== null && testId !== "") {
        if (typeof testId !== "string") {
          return reply.code(400).send({ error: "Test ID must be a string" });
        }
        if (!ObjectId.isValid(testId)) {
          return reply.code(400).send({ error: "Invalid test ID format" });
        }
      }

      // Validate categoryId
      if (categoryId !== undefined && categoryId !== null && categoryId !== "") {
        if (typeof categoryId !== "string") {
          return reply.code(400).send({ error: "Category ID must be a string" });
        }
        if (!ObjectId.isValid(categoryId)) {
          return reply.code(400).send({ error: "Invalid category ID format" });
        }
      }

      // Validate schemaId
      if (schemaId !== undefined && schemaId !== null && schemaId !== "") {
        if (typeof schemaId !== "string") {
          return reply.code(400).send({ error: "Schema ID must be a string" });
        }
        if (!ObjectId.isValid(schemaId)) {
          return reply.code(400).send({ error: "Invalid schema ID format" });
        }
      }

      // Validate price
      if (price !== undefined && price !== null && price !== "") {
        if (typeof price !== "number" && isNaN(parseFloat(price))) {
          return reply.code(400).send({ error: "Price must be a valid number" });
        }
        const parsedPrice = parseFloat(price);
        if (parsedPrice < 0) {
          return reply.code(400).send({ error: "Price must not be negative" });
        }
        if (parsedPrice > 1_000_000) {
          return reply.code(400).send({ error: "Price must not exceed 1,000,000" });
        }
        if (!/^\d+(\.\d{1,2})?$/.test(String(parsedPrice))) {
          return reply.code(400).send({ error: "Price must have at most 2 decimal places" });
        }
      }

      const newTest = {
        name: name.trim(),
        testId: testId || null,
        categoryId: categoryId || null,
        schemaId: schemaId || null,
        price: parseFloat(price) || 0,
      };

      const result = await collection.insertOne(newTest);

      return reply.code(201).send({
        _id: result.insertedId,
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

      // Validate body exists
      if (!req.body || typeof req.body !== "object") {
        return reply.code(400).send({ error: "Request body is required" });
      }

      if (!ObjectId.isValid(testId)) {
        return reply.code(400).send({ error: "Invalid test ID format" });
      }

      // Check if at least one field is provided
      if (price === undefined && schemaId === undefined) {
        return reply.code(400).send({ error: "At least one field (price or schemaId) is required" });
      }

      const updateData = {};

      // Validate and add price if provided
      if (price !== undefined && price !== null) {
        if (typeof price !== "number" && isNaN(parseFloat(price))) {
          return reply.code(400).send({ error: "Price must be a valid number" });
        }
        const parsedPrice = parseFloat(price);
        if (parsedPrice < 0) {
          return reply.code(400).send({ error: "Price must not be negative" });
        }
        if (parsedPrice > 1_000_000) {
          return reply.code(400).send({ error: "Price must not exceed 1,000,000" });
        }
        if (!/^\d+(\.\d{1,2})?$/.test(String(parsedPrice))) {
          return reply.code(400).send({ error: "Price must have at most 2 decimal places" });
        }
        updateData.price = parsedPrice;
      }

      // Validate and add schemaId if provided
      if (schemaId !== undefined) {
        if (schemaId !== null && schemaId !== "") {
          if (typeof schemaId !== "string") {
            return reply.code(400).send({ error: "Schema ID must be a string" });
          }
          if (!ObjectId.isValid(schemaId)) {
            return reply.code(400).send({ error: "Invalid schema ID format" });
          }
        }
        updateData.schemaId = schemaId || null;
      }

      const result = await collection.updateOne({ testId: testId }, { $set: updateData });

      if (result.matchedCount === 0) {
        return reply.code(404).send({ error: "Test not found" });
      }

      const updated = await collection.findOne({ testId: testId });
      return updated;
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

  // GET All Test Catalog
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

  // GET Schema by schemaId
  fastify.get("/schema/:schemaId", async (req, reply) => {
    try {
      const { schemaId } = req.params;

      if (!ObjectId.isValid(schemaId)) {
        return reply.code(400).send({ error: "Invalid schema ID format" });
      }

      const schemasCollection = fastify.mongo.db.collection("testSchema");
      const schema = await schemasCollection.findOne({ _id: new ObjectId(schemaId) });

      if (!schema) {
        return reply.code(404).send({ error: "Schema not found" });
      }

      return reply.send(schema);
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch schema" });
    }
  });
}

export default routes;
