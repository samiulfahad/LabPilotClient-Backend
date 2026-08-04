import toObjectId from "../../utils/db.js";

async function outdoorReportRoutes(fastify, options) {
  const invoicesCollection = () => fastify.mongo.db.collection("invoices");
  const labId = (req) => toObjectId(req.user.labId);
  const by = (req) => ({ id: toObjectId(req.user.id), name: req.user.name });

  fastify.addHook("onRequest", fastify.authenticate);

  const requireDownload = { onRequest: [fastify.authorize("testReportDownload")] };
  const requireUpload = { onRequest: [fastify.authorize("testReportUpload")] };

 // ── GET /schema/:schemaId ─────────────────────────────────────────────────
  fastify.get("/report/testSchema/:schemaId", async (req, reply) => {
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

  // ============================================================================
  // POST /report/add
  // Body: { report, invoiceId, testId }
  // ============================================================================
  fastify.post("/report/add", { ...requireUpload }, async (req, reply) => {
    try {
      const { report, invoiceId, testId } = req.body;

      if (!report || !invoiceId || !testId) {
        return reply.code(400).send({ error: "report, invoiceId and testId are required" });
      }

      const invoice = await invoicesCollection().findOne({ invoiceId, labId: labId(req) });
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
        { invoiceId, labId: labId(req) },
        {
          $set: {
            [`tests.${testIndex}.report`]: reportWithDates,
            [`tests.${testIndex}.isCompleted`]: true,
            [`tests.${testIndex}.completedAt`]: Date.now(),
            [`tests.${testIndex}.completedBy`]: by(req),
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
  fastify.put("/report/update", { ...requireUpload }, async (req, reply) => {
    try {
      const { report, invoiceId, testId } = req.body;

      if (!report || !invoiceId || !testId) {
        return reply.code(400).send({ error: "report, invoiceId and testId are required" });
      }

      const invoice = await invoicesCollection().findOne({ invoiceId, labId: labId(req) });
      if (!invoice) {
        return reply.code(404).send({ error: "Invoice not found" });
      }

      const testIndex = invoice.tests.findIndex((t) => t.testId.toString() === testId.toString());

      if (testIndex === -1) {
        return reply.code(404).send({ error: "Test not found in this invoice" });
      }

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
        { invoiceId, labId: labId(req) },
        {
          $set: {
            [`tests.${testIndex}.report`]: reportWithDates,
            [`tests.${testIndex}.isCompleted`]: true,
            [`tests.${testIndex}.updatedAt`]: Date.now(),
            [`tests.${testIndex}.updatedBy`]: by(req),
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
  fastify.put("/report/dates", { ...requireUpload }, async (req, reply) => {
    try {
      const { invoiceId, testId, sampleCollectionDate, reportDate } = req.body;

      if (!invoiceId || !testId) {
        return reply.code(400).send({ error: "invoiceId and testId are required" });
      }

      if (sampleCollectionDate === undefined && reportDate === undefined) {
        return reply.code(400).send({ error: "At least one of sampleCollectionDate or reportDate is required" });
      }

      const invoice = await invoicesCollection().findOne({ invoiceId, labId: labId(req) });
      if (!invoice) {
        return reply.code(404).send({ error: "Invoice not found" });
      }

      const testIndex = invoice.tests.findIndex((t) => t.testId.toString() === testId.toString());

      if (testIndex === -1) {
        return reply.code(404).send({ error: "Test not found in this invoice" });
      }

      // Parity with indoor-report/dates — offline tests (no schemaId) don't support report dates
      if (!invoice.tests[testIndex].schemaId) {
        return reply.code(400).send({ error: "This test is offline and does not support report dates" });
      }

      const dateFields = {};
      if (sampleCollectionDate !== undefined) {
        dateFields[`tests.${testIndex}.report.sampleCollectionDate`] = sampleCollectionDate;
      }
      if (reportDate !== undefined) {
        dateFields[`tests.${testIndex}.report.reportDate`] = reportDate;
      }

      const result = await invoicesCollection().updateOne({ invoiceId, labId: labId(req) }, { $set: dateFields });

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
  fastify.get("/report/:invoiceId/:testId", { ...requireDownload }, async (req, reply) => {
    try {
      const { invoiceId, testId } = req.params;

      const invoice = await invoicesCollection().findOne({ invoiceId, labId: labId(req) });
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
        completedBy: test.completedBy ?? null,
        updatedAt: test.updatedAt ?? null,
        updatedBy: test.updatedBy ?? null,
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
}

export default outdoorReportRoutes;
