import { ObjectId } from "mongodb";

async function reportRoutes(fastify, options) {
  const invoicesCollection = () => fastify.mongo.db.collection("invoices");

  // ============================================================================
  // POST /report/add
  // Body: { report, invoiceId, testId }
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

      const testIndex = invoice.tests.findIndex((t) => t.testId.toString() === testId.toString());

      if (testIndex === -1) {
        return reply.code(404).send({ error: "Test not found in this invoice" });
      }

      if (invoice.tests[testIndex].isCompleted) {
        return reply.code(400).send({ error: "Report already submitted for this test. Use update instead." });
      }

      // Preserve any dates that were set before the report was uploaded
      const existingReport = invoice.tests[testIndex].report ?? {};
      const reportWithDates = {
        ...report,
        ...(existingReport.sampleCollectionDate !== undefined && {
          sampleCollectionDate: existingReport.sampleCollectionDate,
        }),
        ...(existingReport.reportDate !== undefined && {
          reportDate: existingReport.reportDate,
        }),
      };

      const result = await invoicesCollection().updateOne(
        { invoiceId },
        {
          $set: {
            [`tests.${testIndex}.report`]: reportWithDates,
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
  // Body: { report, invoiceId, testId }
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

      // Preserve existing dates when overwriting report content
      const existingReport = invoice.tests[testIndex].report ?? {};
      const reportWithDates = {
        ...report,
        ...(existingReport.sampleCollectionDate !== undefined && {
          sampleCollectionDate: existingReport.sampleCollectionDate,
        }),
        ...(existingReport.reportDate !== undefined && {
          reportDate: existingReport.reportDate,
        }),
      };

      const result = await invoicesCollection().updateOne(
        { invoiceId },
        {
          $set: {
            [`tests.${testIndex}.report`]: reportWithDates,
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
  // PUT /report/dates
  // Body: { invoiceId, testId, sampleCollectionDate?, reportDate? }
  // Works regardless of whether the report has been submitted yet
  // ============================================================================
  fastify.put("/report/dates", async (req, reply) => {
    try {
      const { invoiceId, testId, sampleCollectionDate, reportDate } = req.body;

      if (!invoiceId || !testId) {
        return reply.code(400).send({ error: "invoiceId and testId are required" });
      }

      if (sampleCollectionDate === undefined && reportDate === undefined) {
        return reply.code(400).send({ error: "At least one of sampleCollectionDate or reportDate is required" });
      }

      const invoice = await invoicesCollection().findOne({ invoiceId });
      if (!invoice) {
        return reply.code(404).send({ error: "Invoice not found" });
      }

      const testIndex = invoice.tests.findIndex((t) => t.testId.toString() === testId.toString());

      if (testIndex === -1) {
        return reply.code(404).send({ error: "Test not found in this invoice" });
      }

      const dateFields = {};
      if (sampleCollectionDate !== undefined) {
        dateFields[`tests.${testIndex}.report.sampleCollectionDate`] = sampleCollectionDate;
      }
      if (reportDate !== undefined) {
        dateFields[`tests.${testIndex}.report.reportDate`] = reportDate;
      }

      const result = await invoicesCollection().updateOne({ invoiceId }, { $set: dateFields });

      if (result.modifiedCount === 0) {
        return reply.code(400).send({ error: "Failed to update dates" });
      }

      return reply.send({ success: true });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to update dates" });
    }
  });

  // ============================================================================
  // GET /report/:invoiceId/:testId
  // Returns the report + patient info from the parent invoice
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
        patient: invoice.patient,
        referrer: invoice.referrer,
        invoiceId: invoice.invoiceId,
        testName: test.name,
        schemaId: test.schemaId,
        reportDate: test.report?.reportDate ?? null,
        sampleCollectionDate: test.report?.sampleCollectionDate ?? null,
      });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch report" });
    }
  });

  // ============================================================================
  // GET /report/all
  // ============================================================================
  fastify.get("/report/all", async (req, reply) => {
    try {
      const invoices = await invoicesCollection()
        .aggregate([
          { $match: { "tests.isCompleted": true } },
          { $unwind: { path: "$tests", includeArrayIndex: "testIndex" } },
          { $match: { "tests.isCompleted": true } },
          {
            $project: {
              _id: 0,
              invoiceId: 1,
              // patient is a nested object — expose the fields explicitly
              patientName: "$patient.name",
              patientGender: "$patient.gender",
              patientAge: "$patient.age",
              contactNumber: "$patient.contactNumber",
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
