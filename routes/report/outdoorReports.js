/**
 * outdoorReportRoutes.js
 *
 * Structure mirrors invoiceRoutes.js: Constants → Helpers → Route Schemas → Routes.
 *
 * Cleanup notes:
 *  - GET /report/testSchema/:schemaId is intentionally left WITHOUT a permission
 *    gate and WITHOUT a labId filter — testSchemas is shared reference data (report
 *    templates), not a lab-scoped collection, so there's nothing tenant-specific to
 *    leak by _id lookup. Revisit only if testSchemas ever becomes lab-owned.
 *  - All other routes (add, update, dates, get-by-invoice) are gated on
 *    testReportUpload / testReportDownload, unchanged.
 */

import toObjectId from "../../utils/db.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const findTestIndex = (tests, testId) => (tests ?? []).findIndex((t) => t.testId.toString() === testId.toString());

// sampleCollectionDate/reportDate are set independently of the report body
// (via PUT /report/dates) and must survive being overwritten whenever the
// report content itself is added or updated.
const mergeReportDates = (existingReport, incomingReport) => ({
  ...incomingReport,
  ...(existingReport?.sampleCollectionDate !== undefined && {
    sampleCollectionDate: existingReport.sampleCollectionDate,
  }),
  ...(existingReport?.reportDate !== undefined && {
    reportDate: existingReport.reportDate,
  }),
});

// ─── Route Schemas ────────────────────────────────────────────────────────────

const getSchemaParamSchema = {
  schema: {
    tags: ["Outdoor Reports"],
    summary: "Get a test report schema by ID",
    params: {
      type: "object",
      required: ["schemaId"],
      properties: {
        schemaId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the schema" },
      },
    },
  },
};

const addReportSchema = {
  schema: {
    tags: ["Outdoor Reports"],
    summary: "Add a report to a not-yet-completed test on an invoice",
    body: {
      type: "object",
      required: ["report", "invoiceId", "testId"],
      properties: {
        report: { type: "object", description: "Report data keyed by schema field name" },
        invoiceId: { type: "string", minLength: 7, maxLength: 7, description: "Invoice ID" },
        testId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the test" },
      },
    },
  },
};

const updateReportSchema = {
  schema: {
    tags: ["Outdoor Reports"],
    summary: "Update the report for a test on an invoice",
    body: {
      type: "object",
      required: ["report", "invoiceId", "testId"],
      properties: {
        report: { type: "object", description: "Report data keyed by schema field name" },
        invoiceId: { type: "string", minLength: 7, maxLength: 7, description: "Invoice ID" },
        testId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the test" },
      },
    },
  },
};

const updateDatesSchema = {
  schema: {
    tags: ["Outdoor Reports"],
    summary: "Update sample collection / report dates for a test — works before or after report submission",
    body: {
      type: "object",
      required: ["invoiceId", "testId"],
      properties: {
        invoiceId: { type: "string", minLength: 7, maxLength: 7, description: "Invoice ID" },
        testId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the test" },
        sampleCollectionDate: { type: "integer", description: "Unix timestamp (ms) of sample collection" },
        reportDate: { type: "integer", description: "Unix timestamp (ms) the report was finalized" },
      },
    },
  },
};

const getReportSchema = {
  schema: {
    tags: ["Outdoor Reports"],
    summary: "Get the report + patient info for a test on an invoice",
    params: {
      type: "object",
      required: ["invoiceId", "testId"],
      properties: {
        invoiceId: { type: "string", minLength: 7, maxLength: 7, description: "Invoice ID" },
        testId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the test" },
      },
    },
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

async function outdoorReportRoutes(fastify) {
  const invoicesCollection = () => fastify.mongo.db.collection("invoices");
  const labId = (req) => toObjectId(req.user.labId);
  const by = (req) => ({ id: toObjectId(req.user.id), name: req.user.name });

  fastify.addHook("onRequest", fastify.authenticate);

  const requireDownload = { onRequest: [fastify.authorize("testReportDownload")] };
  const requireUpload = { onRequest: [fastify.authorize("testReportUpload")] };

  // ── GET /report/testSchema/:schemaId ────────────────────────────────────
  // Intentionally unguarded — see header cleanup notes: shared reference
  // data, not lab-scoped.
  fastify.get("/report/testSchema/:schemaId", getSchemaParamSchema, async (req, reply) => {
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

  // ── POST /report/add ────────────────────────────────────────────────────
  fastify.post("/report/add", { ...addReportSchema, ...requireUpload }, async (req, reply) => {
    try {
      const { report, invoiceId, testId } = req.body;

      const invoice = await invoicesCollection().findOne({ invoiceId, labId: labId(req) });
      if (!invoice) return reply.code(404).send({ error: "Invoice not found" });

      const testIndex = findTestIndex(invoice.tests, testId);
      if (testIndex === -1) return reply.code(404).send({ error: "Test not found in this invoice" });

      if (invoice.tests[testIndex].isCompleted) {
        return reply.code(400).send({ error: "Report already submitted for this test. Use update instead." });
      }

      const reportWithDates = mergeReportDates(invoice.tests[testIndex].report, report);

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

      if (result.modifiedCount === 0) return reply.code(400).send({ error: "Failed to save report" });
      return reply.code(201).send({ success: true });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to add report" });
    }
  });

  // ── PUT /report/update ──────────────────────────────────────────────────
  fastify.put("/report/update", { ...updateReportSchema, ...requireUpload }, async (req, reply) => {
    try {
      const { report, invoiceId, testId } = req.body;

      const invoice = await invoicesCollection().findOne({ invoiceId, labId: labId(req) });
      if (!invoice) return reply.code(404).send({ error: "Invoice not found" });

      const testIndex = findTestIndex(invoice.tests, testId);
      if (testIndex === -1) return reply.code(404).send({ error: "Test not found in this invoice" });

      const reportWithDates = mergeReportDates(invoice.tests[testIndex].report, report);

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

      if (result.modifiedCount === 0) return reply.code(400).send({ error: "Failed to update report" });
      return reply.send({ success: true });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to update report" });
    }
  });

  // ── PUT /report/dates ───────────────────────────────────────────────────
  // Works regardless of whether the report has been submitted yet.
  fastify.put("/report/dates", { ...updateDatesSchema, ...requireUpload }, async (req, reply) => {
    try {
      const { invoiceId, testId, sampleCollectionDate, reportDate } = req.body;

      if (sampleCollectionDate === undefined && reportDate === undefined) {
        return reply.code(400).send({ error: "At least one of sampleCollectionDate or reportDate is required" });
      }

      const invoice = await invoicesCollection().findOne({ invoiceId, labId: labId(req) });
      if (!invoice) return reply.code(404).send({ error: "Invoice not found" });

      const testIndex = findTestIndex(invoice.tests, testId);
      if (testIndex === -1) return reply.code(404).send({ error: "Test not found in this invoice" });

      // Parity with indoor-report/dates — offline tests (no schemaId) don't support report dates.
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
      if (result.modifiedCount === 0) return reply.code(400).send({ error: "Failed to update dates" });
      return reply.send({ success: true });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to update dates" });
    }
  });

  // ── GET /report/:invoiceId/:testId ──────────────────────────────────────
  // Returns the report + patient info from the parent invoice.
  fastify.get("/report/:invoiceId/:testId", { ...getReportSchema, ...requireDownload }, async (req, reply) => {
    try {
      const { invoiceId, testId } = req.params;

      const invoice = await invoicesCollection().findOne({ invoiceId, labId: labId(req) });
      if (!invoice) return reply.code(404).send({ error: "Invoice not found" });

      const test = invoice.tests.find((t) => t.testId.toString() === testId.toString());
      if (!test) return reply.code(404).send({ error: "Test not found in this invoice" });

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
