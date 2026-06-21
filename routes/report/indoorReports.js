import toObjectId from "../../utils/db.js";

const COLLECTION = "indoorPatients";

async function indoorReportRoutes(fastify) {
  const col = () => fastify.mongo.db.collection(COLLECTION);
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);

  // ============================================================================
  // POST /indoor-report/add
  // Body: { report, patientId, testId }
  // ============================================================================
  fastify.post("/indoor-report/add", async (req, reply) => {
    try {
      const { report, patientId, testId } = req.body;

      if (!report || !patientId || !testId) {
        return reply.code(400).send({ error: "report, patientId and testId are required" });
      }

      const _id = toObjectId(patientId);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const admission = await col().findOne({ _id, labId: labId(req) });
      if (!admission) {
        return reply.code(404).send({ error: "Indoor patient not found" });
      }

      const reportIndex = (admission.reports ?? []).findIndex((r) => r.testId?.toString() === testId.toString());

      if (reportIndex === -1) {
        return reply.code(404).send({ error: "Report entry not found for this test on this admission" });
      }

      if (admission.reports[reportIndex].isCompleted) {
        return reply.code(400).send({ error: "Report already submitted for this test. Use update instead." });
      }

      // Preserve any dates that were set before the report was uploaded
      const existingReport = admission.reports[reportIndex].report ?? {};
      const reportWithDates = {
        ...report,
        ...(existingReport.sampleCollectionDate !== undefined && {
          sampleCollectionDate: existingReport.sampleCollectionDate,
        }),
        ...(existingReport.reportDate !== undefined && {
          reportDate: existingReport.reportDate,
        }),
      };

      const result = await col().updateOne(
        { _id, labId: labId(req) },
        {
          $set: {
            [`reports.${reportIndex}.report`]: reportWithDates,
            [`reports.${reportIndex}.isCompleted`]: true,
            [`reports.${reportIndex}.completedAt`]: Date.now(),
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
  // PUT /indoor-report/update
  // Body: { report, patientId, testId }
  // ============================================================================
  fastify.put("/indoor-report/update", async (req, reply) => {
    try {
      const { report, patientId, testId } = req.body;

      if (!report || !patientId || !testId) {
        return reply.code(400).send({ error: "report, patientId and testId are required" });
      }

      const _id = toObjectId(patientId);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const admission = await col().findOne({ _id, labId: labId(req) });
      if (!admission) {
        return reply.code(404).send({ error: "Indoor patient not found" });
      }

      const reportIndex = (admission.reports ?? []).findIndex((r) => r.testId?.toString() === testId.toString());

      if (reportIndex === -1) {
        return reply.code(404).send({ error: "Report entry not found for this test on this admission" });
      }

      // Preserve existing dates when overwriting report content
      const existingReport = admission.reports[reportIndex].report ?? {};
      const reportWithDates = {
        ...report,
        ...(existingReport.sampleCollectionDate !== undefined && {
          sampleCollectionDate: existingReport.sampleCollectionDate,
        }),
        ...(existingReport.reportDate !== undefined && {
          reportDate: existingReport.reportDate,
        }),
      };

      const result = await col().updateOne(
        { _id, labId: labId(req) },
        {
          $set: {
            [`reports.${reportIndex}.report`]: reportWithDates,
            [`reports.${reportIndex}.isCompleted`]: true,
            [`reports.${reportIndex}.updatedAt`]: Date.now(),
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
  // PUT /indoor-report/dates
  // Body: { patientId, testId, sampleCollectionDate?, reportDate? }
  // Works regardless of whether the report has been submitted yet
  // ============================================================================
  fastify.put("/indoor-report/dates", async (req, reply) => {
    try {
      const { patientId, testId, sampleCollectionDate, reportDate } = req.body;

      if (!patientId || !testId) {
        return reply.code(400).send({ error: "patientId and testId are required" });
      }

      if (sampleCollectionDate === undefined && reportDate === undefined) {
        return reply.code(400).send({ error: "At least one of sampleCollectionDate or reportDate is required" });
      }

      const _id = toObjectId(patientId);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const admission = await col().findOne({ _id, labId: labId(req) });
      if (!admission) {
        return reply.code(404).send({ error: "Indoor patient not found" });
      }

      const reportIndex = (admission.reports ?? []).findIndex((r) => r.testId?.toString() === testId.toString());

      if (reportIndex === -1) {
        return reply.code(404).send({ error: "Report entry not found for this test on this admission" });
      }

      const dateFields = {};
      if (sampleCollectionDate !== undefined) {
        dateFields[`reports.${reportIndex}.report.sampleCollectionDate`] = sampleCollectionDate;
      }
      if (reportDate !== undefined) {
        dateFields[`reports.${reportIndex}.report.reportDate`] = reportDate;
      }

      const result = await col().updateOne({ _id, labId: labId(req) }, { $set: dateFields });

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
  // GET /indoor-report/:patientId/:testId
  // Returns the report + patient info from the parent admission
  // ============================================================================
  fastify.get("/indoor-report/:patientId/:testId", async (req, reply) => {
    try {
      const { patientId, testId } = req.params;

      const _id = toObjectId(patientId);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const admission = await col().findOne({ _id, labId: labId(req) });
      if (!admission) {
        return reply.code(404).send({ error: "Indoor patient not found" });
      }

      const reportEntry = (admission.reports ?? []).find((r) => r.testId?.toString() === testId.toString());

      if (!reportEntry) {
        return reply.code(404).send({ error: "Report entry not found for this test on this admission" });
      }

      return reply.send({
        report: reportEntry.report,
        isCompleted: reportEntry.isCompleted,
        completedAt: reportEntry.completedAt ?? null,
        updatedAt: reportEntry.updatedAt ?? null,
        patient: admission.patient,
        referrer: admission.referrer,
        admissionId: admission.admissionId,
        testName: reportEntry.name,
        schemaId: reportEntry.schemaId,
        reportDate: reportEntry.report?.reportDate ?? null,
        sampleCollectionDate: reportEntry.report?.sampleCollectionDate ?? null,
      });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch report" });
    }
  });

  // ============================================================================
  // GET /indoor-report/all
  // ============================================================================
  fastify.get("/indoor-report/all", async (req, reply) => {
    try {
      const admissions = await col()
        .aggregate([
          { $match: { labId: labId(req), "reports.isCompleted": true } },
          { $unwind: { path: "$reports", includeArrayIndex: "reportIndex" } },
          { $match: { "reports.isCompleted": true } },
          {
            $project: {
              _id: 0,
              admissionId: 1,
              patientName: "$patient.name",
              patientGender: "$patient.gender",
              patientAge: "$patient.age",
              contactNumber: "$patient.contactNumber",
              testId: "$reports.testId",
              testName: "$reports.name",
              schemaId: "$reports.schemaId",
              report: "$reports.report",
              isCompleted: "$reports.isCompleted",
              completedAt: "$reports.completedAt",
              updatedAt: "$reports.updatedAt",
            },
          },
          { $sort: { completedAt: -1 } },
        ])
        .toArray();

      return reply.send(admissions);
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch reports" });
    }
  });
}

export default indoorReportRoutes;