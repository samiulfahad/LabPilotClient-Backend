import toObjectId from "../../utils/db.js";

const COLLECTION = "indoorPatients";

async function indoorReportRoutes(fastify) {
  const col = () => fastify.mongo.db.collection(COLLECTION);
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);

  // ============================================================================
  // POST /indoor-report/add
  // Body: { report, patientId, testId }
  // Uses first incomplete entry — no addedAt needed for add
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
      if (!admission) return reply.code(404).send({ error: "Indoor patient not found" });

      // Find the first INCOMPLETE entry for this testId
      const reportIndex = (admission.reports ?? []).findIndex(
        (r) => r.testId?.toString() === testId.toString() && !r.isCompleted,
      );
      if (reportIndex === -1) {
        return reply.code(404).send({ error: "No pending report entry found for this test on this admission" });
      }

      const reportEntry = admission.reports[reportIndex];

      if (!reportEntry.schemaId) {
        return reply.code(400).send({ error: "This test is offline and does not support report upload" });
      }

      const existingReport = reportEntry.report ?? {};
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

      if (result.modifiedCount === 0) return reply.code(400).send({ error: "Failed to save report" });
      return reply.code(201).send({ success: true });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to add report" });
    }
  });

  // ============================================================================
  // PUT /indoor-report/update
  // Body: { report, patientId, testId, addedAt }
  // addedAt disambiguates when the same test appears multiple times
  // ============================================================================
  fastify.put("/indoor-report/update", async (req, reply) => {
    try {
      const { report, patientId, testId, addedAt } = req.body;

      if (!report || !patientId || !testId || !addedAt) {
        return reply.code(400).send({ error: "report, patientId, testId and addedAt are required" });
      }

      const _id = toObjectId(patientId);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const admission = await col().findOne({ _id, labId: labId(req) });
      if (!admission) return reply.code(404).send({ error: "Indoor patient not found" });

      // console.log("update body:", JSON.stringify({ testId, addedAt, addedAtType: typeof addedAt }));
      // console.log(
      //   "reports addedAts:",
      //   admission.reports.map((r) => ({ addedAt: r.addedAt, type: typeof r.addedAt })),
      // );
      // Match by testId + addedAt for precise targeting
      const reportIndex = (admission.reports ?? []).findIndex(
        (r) => r.testId?.toString() === testId.toString() && r.addedAt === Number(addedAt),
      );
      if (reportIndex === -1) {
        return reply.code(404).send({ error: "Report entry not found for this test on this admission" });
      }

      const reportEntry = admission.reports[reportIndex];

      if (!reportEntry.schemaId) {
        return reply.code(400).send({ error: "This test is offline and does not support report upload" });
      }

      const existingReport = reportEntry.report ?? {};
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

      if (result.modifiedCount === 0) return reply.code(400).send({ error: "Failed to update report" });
      return reply.send({ success: true });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to update report" });
    }
  });

  // ============================================================================
  // PUT /indoor-report/dates
  // Body: { patientId, testId, addedAt, sampleCollectionDate?, reportDate? }
  // ============================================================================
  fastify.put("/indoor-report/dates", async (req, reply) => {
    try {
      const { patientId, testId, addedAt, sampleCollectionDate, reportDate } = req.body;

      if (!patientId || !testId || !addedAt) {
        return reply.code(400).send({ error: "patientId, testId and addedAt are required" });
      }

      if (sampleCollectionDate === undefined && reportDate === undefined) {
        return reply.code(400).send({ error: "At least one of sampleCollectionDate or reportDate is required" });
      }

      const _id = toObjectId(patientId);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const admission = await col().findOne({ _id, labId: labId(req) });
      if (!admission) return reply.code(404).send({ error: "Indoor patient not found" });

      // Match by testId + addedAt for precise targeting
      const reportIndex = (admission.reports ?? []).findIndex(
        (r) => r.testId?.toString() === testId.toString() && r.addedAt === Number(addedAt),
      );
      if (reportIndex === -1) {
        return reply.code(404).send({ error: "Report entry not found for this test on this admission" });
      }

      if (!admission.reports[reportIndex].schemaId) {
        return reply.code(400).send({ error: "This test is offline and does not support report dates" });
      }

      const dateFields = {};
      if (sampleCollectionDate !== undefined) {
        dateFields[`reports.${reportIndex}.report.sampleCollectionDate`] = sampleCollectionDate;
      }
      if (reportDate !== undefined) {
        dateFields[`reports.${reportIndex}.report.reportDate`] = reportDate;
      }

      const result = await col().updateOne({ _id, labId: labId(req) }, { $set: dateFields });

      if (result.modifiedCount === 0) return reply.code(400).send({ error: "Failed to update dates" });
      return reply.send({ success: true });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to update dates" });
    }
  });

  // ============================================================================
  // GET /indoor-report/:patientId/:testId?addedAt=
  // addedAt query param selects a specific entry when duplicates exist
  // ============================================================================
  fastify.get("/indoor-report/:patientId/:testId", async (req, reply) => {
    try {
      const { patientId, testId } = req.params;
      const { addedAt } = req.query;

      const _id = toObjectId(patientId);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const admission = await col().findOne({ _id, labId: labId(req) });
      if (!admission) return reply.code(404).send({ error: "Indoor patient not found" });

      const reports = admission.reports ?? [];
      const matches = reports.filter((r) => r.testId?.toString() === testId.toString());

      // If addedAt provided, target that exact entry; otherwise prefer completed, fallback to first
      const reportEntry = addedAt
        ? matches.find((r) => r.addedAt === Number(addedAt))
        : (matches.find((r) => r.isCompleted) ?? matches[0]);

      if (!reportEntry) {
        return reply.code(404).send({ error: "Report entry not found for this test on this admission" });
      }

      return reply.send({
        testId: reportEntry.testId,
        testName: reportEntry.name,
        schemaId: reportEntry.schemaId,
        addedAt: reportEntry.addedAt,
        ...(reportEntry.schemaId && {
          report: reportEntry.report,
          isCompleted: reportEntry.isCompleted,
          completedAt: reportEntry.completedAt ?? null,
          updatedAt: reportEntry.updatedAt ?? null,
          reportDate: reportEntry.report?.reportDate ?? null,
          sampleCollectionDate: reportEntry.report?.sampleCollectionDate ?? null,
        }),
        patient: admission.patient,
        referrer: admission.referrer,
        admissionId: admission.admissionId,
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
              addedAt: "$reports.addedAt",
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
