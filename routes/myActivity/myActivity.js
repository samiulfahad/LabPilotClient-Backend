/**
 * myActivityRoutes.js
 *
 * Cleanup notes (see audit, mirroring invoiceRoutes.js):
 *  - All three routes below (summary, invoices, collections) are intentionally left
 *    WITHOUT a permission gate. Unlike other collections, there is no meaningful
 *    permission to gate on here: every route is hard-scoped to req.user.id — a staff
 *    member can only ever see their own collection/invoice activity, never another
 *    user's. Gating "view your own activity" behind a permission key would just lock
 *    staff out of their own dashboard for no security benefit. Revisit only if a
 *    future requirement needs e.g. a manager viewing another staff member's activity.
 */

import toObjectId from "../../utils/db.js";

// ─── Constants ────────────────────────────────────────────────────────────────

// Payments and invoices are queried in [startDate, endDate], but the parent
// invoice/admission doc can have been created well before that window (e.g. an
// old invoice getting a due collected today). LOOKBACK_MS widens the initial
// $match on createdAt/admittedAt so we don't miss those parents before the
// $unwind + inner date match narrows back down to the requested range.
const LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// collectedBy.id / addedBy.id on indoorPatients docs is inconsistently
// stored as a raw string in some records instead of ObjectId (write-path
// bug — ids should be normalized with toObjectId() before insert). Until
// that's fixed at the source, match both forms here.
const userIdMatch = (field, userObjectId, userIdRaw) => ({
  $or: [{ [field]: userObjectId }, { [field]: userIdRaw }],
});

// ─── Route Schemas ────────────────────────────────────────────────────────────

const summaryQuerySchema = {
  schema: {
    tags: ["My Activity"],
    summary: "Get the logged-in staff's own collection & invoice activity for a date range",
    querystring: {
      type: "object",
      required: ["startDate", "endDate"],
      properties: {
        startDate: { type: "integer", description: "Start date as Unix timestamp (ms)" },
        endDate: { type: "integer", description: "End date as Unix timestamp (ms)" },
      },
    },
  },
};

const invoicesQuerySchema = {
  schema: {
    tags: ["My Activity"],
    summary: "Get OPD invoices created by the logged-in staff for a date range",
    querystring: summaryQuerySchema.schema.querystring,
  },
};

const collectionsQuerySchema = {
  schema: {
    tags: ["My Activity"],
    summary: "Get all payments collected by the logged-in staff for a date range (OPD + IPD, merged)",
    querystring: summaryQuerySchema.schema.querystring,
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

async function myActivityRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("invoices");
  const indoorCol = () => fastify.mongo.db.collection("indoorPatients");
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);

  // ── GET /my-activity/summary ────────────────────────────────────────────
  // Intentionally unguarded — see header cleanup notes: hard-scoped to
  // req.user.id, so there's nothing to gate.
  fastify.get("/my-activity/summary", summaryQuerySchema, async (req, reply) => {
    const startDate = parseInt(req.query.startDate);
    const endDate = parseInt(req.query.endDate);

    if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

    const userId = toObjectId(req.user.id);
    const isHospital = req.user.type === "hospital";

    try {
      const opdCollectedPipeline = [
        {
          $match: {
            labId: labId(req),
            "deletion.status": false,
            createdAt: { $gte: startDate - LOOKBACK_MS, $lte: endDate },
          },
        },
        { $unwind: "$collections" },
        {
          $match: {
            "collections.at": { $gte: startDate, $lte: endDate },
            ...userIdMatch("collections.by.id", userId, req.user.id),
          },
        },
        { $group: { _id: null, totalCollected: { $sum: "$collections.amount" } } },
      ];

      const ipdCollectedPipeline = [
        {
          $match: {
            labId: labId(req),
            admittedAt: { $gte: startDate - LOOKBACK_MS, $lte: endDate },
          },
        },
        { $unwind: "$payments" },
        {
          $match: {
            "payments.collectedAt": { $gte: startDate, $lte: endDate },
            ...userIdMatch("payments.collectedBy.id", userId, req.user.id),
          },
        },
        { $group: { _id: null, totalCollected: { $sum: "$payments.amount" } } },
      ];

      const invoiceCountPipeline = [
        {
          $match: {
            labId: labId(req),
            "deletion.status": false,
            "createdBy.id": userId,
            createdAt: { $gte: startDate, $lte: endDate },
          },
        },
        { $count: "count" },
      ];

      const [opdRes, ipdRes, invoiceRes] = await Promise.all([
        col().aggregate(opdCollectedPipeline, { allowDiskUse: true }).toArray(),
        isHospital ? indoorCol().aggregate(ipdCollectedPipeline, { allowDiskUse: true }).toArray() : [],
        col().aggregate(invoiceCountPipeline, { allowDiskUse: true }).toArray(),
      ]);

      const opdCollected = opdRes[0]?.totalCollected ?? 0;
      const ipdCollected = ipdRes[0]?.totalCollected ?? 0;
      const invoiceCount = invoiceRes[0]?.count ?? 0;

      return reply.send({
        totalCollected: opdCollected + ipdCollected,
        opdCollected,
        ipdCollected,
        invoiceCount,
        isHospital,
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch activity summary" });
    }
  });

  // ── GET /my-activity/invoices ───────────────────────────────────────────
  // OPD invoices created by this staff in range — minimal projection.
  // Intentionally unguarded — see header cleanup notes.
  fastify.get("/my-activity/invoices", invoicesQuerySchema, async (req, reply) => {
    const startDate = parseInt(req.query.startDate);
    const endDate = parseInt(req.query.endDate);

    if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

    const userId = toObjectId(req.user.id);

    try {
      const invoices = await col()
        .find(
          {
            labId: labId(req),
            "deletion.status": false,
            "createdBy.id": userId,
            createdAt: { $gte: startDate, $lte: endDate },
          },
          {
            projection: {
              invoiceId: 1,
              createdAt: 1,
              "patient.name": 1,
              "amount.final": 1,
              "amount.paid": 1,
            },
          },
        )
        .sort({ createdAt: -1 })
        .toArray();

      return reply.send({ invoices });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch invoices" });
    }
  });

  // ── GET /my-activity/collections ────────────────────────────────────────
  // All payments this staff collected in range — OPD invoice collections +
  // IPD payments, merged into one flat list with a `source` tag.
  // Intentionally unguarded — see header cleanup notes.
  fastify.get("/my-activity/collections", collectionsQuerySchema, async (req, reply) => {
    const startDate = parseInt(req.query.startDate);
    const endDate = parseInt(req.query.endDate);

    if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

    const userId = toObjectId(req.user.id);
    const isHospital = req.user.type === "hospital";

    try {
      const opdCollectionsPipeline = [
        {
          $match: {
            labId: labId(req),
            "deletion.status": false,
            createdAt: { $gte: startDate - LOOKBACK_MS, $lte: endDate },
          },
        },
        { $unwind: "$collections" },
        {
          $match: {
            "collections.at": { $gte: startDate, $lte: endDate },
            ...userIdMatch("collections.by.id", userId, req.user.id),
          },
        },
        {
          $project: {
            _id: 0,
            source: { $literal: "opd" },
            refId: "$invoiceId",
            patientName: "$patient.name",
            amount: "$collections.amount",
            at: "$collections.at",
          },
        },
      ];

      const ipdCollectionsPipeline = [
        {
          $match: {
            labId: labId(req),
            admittedAt: { $gte: startDate - LOOKBACK_MS, $lte: endDate },
          },
        },
        { $unwind: "$payments" },
        {
          $match: {
            "payments.collectedAt": { $gte: startDate, $lte: endDate },
            ...userIdMatch("payments.collectedBy.id", userId, req.user.id),
          },
        },
        {
          $project: {
            _id: 0,
            source: { $literal: "ipd" },
            refId: "$admissionId",
            patientName: "$patient.name",
            amount: "$payments.amount",
            at: "$payments.collectedAt",
          },
        },
      ];

      const [opdList, ipdList] = await Promise.all([
        col().aggregate(opdCollectionsPipeline, { allowDiskUse: true }).toArray(),
        isHospital ? indoorCol().aggregate(ipdCollectionsPipeline, { allowDiskUse: true }).toArray() : [],
      ]);

      const collections = [...opdList, ...ipdList].sort((a, b) => b.at - a.at);

      return reply.send({ collections });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch collections" });
    }
  });
}

export default myActivityRoutes;
