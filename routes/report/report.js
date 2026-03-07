import { ObjectId } from "mongodb";

async function reportRoutes(fastify, options) {
  const invoicesCollection = () => fastify.mongo.db.collection("invoices");

  // ============================================================================
  // POST /report/add
  // Body: { report: <SchemaRenderer payload>, invoiceId: "RAE3956", testId: "..." }
  //
  // Finds the matching test inside invoice.tests[] by testId,
  // sets tests[i].report = payload and tests[i].isCompleted = true
  // ============================================================================
  fastify.post("/report/add", async (req, reply) => {
    try {
      const { report, invoiceId, testId } = req.body;

      if (!report || !invoiceId || !testId) {
        return reply.code(400).send({ error: "report, invoiceId and testId are required" });
      }

      const invoice = await invoicesCollection().findOne({ invoiceId });
      if (!invoice) {
        return reply.code(404).send({ error: "Invoice not found" });
      }

      // Find the index of the matching test
      const testIndex = invoice.tests.findIndex((t) => t.testId.toString() === testId.toString());

      if (testIndex === -1) {
        return reply.code(404).send({ error: "Test not found in this invoice" });
      }

      if (invoice.tests[testIndex].isCompleted) {
        return reply.code(400).send({ error: "Report already submitted for this test. Use update instead." });
      }

      // Build the dynamic $set key for the specific test in the array
      const result = await invoicesCollection().updateOne(
        { invoiceId },
        {
          $set: {
            [`tests.${testIndex}.report`]: report,
            [`tests.${testIndex}.isCompleted`]: true,
            [`tests.${testIndex}.completedAt`]: Date.now(),
          },
        },
      );

      if (result.modifiedCount === 0) {
        return reply.code(400).send({ error: "Failed to save report" });
      }

      return reply.code(201).send({ success: true });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to add report" });
    }
  });

  // ============================================================================
  // PUT /report/update
  // Body: { report: <SchemaRenderer payload>, invoiceId: "RAE3956", testId: "..." }
  //
  // Same lookup — overwrites tests[i].report with the new payload
  // ============================================================================
  fastify.put("/report/update", async (req, reply) => {
    try {
      const { report, invoiceId, testId } = req.body;

      if (!report || !invoiceId || !testId) {
        return reply.code(400).send({ error: "report, invoiceId and testId are required" });
      }

      const invoice = await invoicesCollection().findOne({ invoiceId });
      if (!invoice) {
        return reply.code(404).send({ error: "Invoice not found" });
      }

      const testIndex = invoice.tests.findIndex((t) => t.testId.toString() === testId.toString());

      if (testIndex === -1) {
        return reply.code(404).send({ error: "Test not found in this invoice" });
      }

      const result = await invoicesCollection().updateOne(
        { invoiceId },
        {
          $set: {
            [`tests.${testIndex}.report`]: report,
            [`tests.${testIndex}.isCompleted`]: true,
            [`tests.${testIndex}.updatedAt`]: Date.now(),
          },
        },
      );

      if (result.modifiedCount === 0) {
        return reply.code(400).send({ error: "Failed to update report" });
      }

      return reply.send({ success: true });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to update report" });
    }
  });

  // ============================================================================
  // GET /report/:invoiceId/:testId
  // Returns the embedded report for a specific test in an invoice
  // ============================================================================
  fastify.get("/report/:invoiceId/:testId", async (req, reply) => {
    try {
      const { invoiceId, testId } = req.params;

      const invoice = await invoicesCollection().findOne({ invoiceId });
      if (!invoice) {
        return reply.code(404).send({ error: "Invoice not found" });
      }

      const test = invoice.tests.find((t) => t.testId.toString() === testId.toString());

      if (!test) {
        return reply.code(404).send({ error: "Test not found in this invoice" });
      }

      return reply.send({
        report: test.report,
        isCompleted: test.isCompleted,
        completedAt: test.completedAt ?? null,
        updatedAt: test.updatedAt ?? null,
      });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch report" });
    }
  });

  // ============================================================================
  // GET /report/all
  // Returns all completed reports across all invoices — flattened list
  // Useful for the ReportList page
  // ============================================================================
  fastify.get("/report/all", async (req, reply) => {
    try {
      const invoices = await invoicesCollection()
        .aggregate([
          // Only invoices that have at least one completed test
          { $match: { "tests.isCompleted": true } },
          // Unwind tests so each test becomes its own document
          { $unwind: { path: "$tests", includeArrayIndex: "testIndex" } },
          // Only keep completed tests
          { $match: { "tests.isCompleted": true } },
          {
            $project: {
              _id: 0,
              invoiceId: 1,
              patientName: 1,
              gender: 1,
              age: 1,
              contactNumber: 1,
              testId: "$tests.testId",
              testName: "$tests.name",
              schemaId: "$tests.schemaId",
              report: "$tests.report",
              isCompleted: "$tests.isCompleted",
              completedAt: "$tests.completedAt",
              updatedAt: "$tests.updatedAt",
            },
          },
          { $sort: { completedAt: -1 } },
        ])
        .toArray();

      return reply.send(invoices);
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch reports" });
    }
  });
}

export default reportRoutes;
