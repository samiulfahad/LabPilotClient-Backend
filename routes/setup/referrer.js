/**
 * referrerRoutes.js
 *
 * Audited — no functional bugs found. Same labId scoping and percentage-cap
 * validation pattern as doctorRoutes.js.
 *
 * LIMIT CHECK (added): GET /referrers now returns { referrers, maxReferrer }
 * instead of a bare array — this is a breaking response-shape change, so the
 * frontend (ManageReferrer) has been updated to match. POST /referrer/add
 * enforces lab.limit.maxReferrer as the authoritative gate; the frontend
 * also disables its "New Referrer" button proactively once the limit is
 * reached, but that's UX only.
 *
 * Other non-bug observations, left unchanged:
 *  - DELETE /referrer/:id is a hard delete with no reference check — same
 *    reasoning as doctorRoutes.js applies (indoorPatients denormalizes
 *    referrer name/type at admission time, so this is safe, just leaves a
 *    dangling referrerId).
 */
import toObjectId from "../../utils/db.js";

const collectionName = "referrers";

// ─── Reusable Schema Fragments ────────────────────────────────────────────────

const objectIdSchema = {
  type: "string",
  minLength: 24,
  maxLength: 24,
  description: "MongoDB ObjectId (24-character hex string)",
};

const referrerIdParamSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { ...objectIdSchema, description: "ObjectId of the referrer" },
  },
};

// ─── Body Properties ──────────────────────────────────────────────────────────

const referrerBodyProperties = {
  name: { type: "string", minLength: 1, maxLength: 100, description: "Full name of the referrer" },
  contactNumber: { type: "string", minLength: 1, maxLength: 15, description: "Phone/contact number" },
  degree: { type: "string", maxLength: 200, description: "Degree or qualification (optional)" },
  details: { type: "string", maxLength: 500, description: "Additional details (optional)" },
  type: { type: "string", enum: ["doctor", "agent", "institute"], description: "Type of referrer" },
  commissionType: { type: "string", enum: ["percentage", "fixed"], description: "How commission is calculated" },
  commissionValue: { type: "number", minimum: 0, description: "Commission amount (max 100 if percentage)" },
};

// ─── Route Schemas ────────────────────────────────────────────────────────────

const getAllReferrersSchema = {
  schema: {
    tags: ["Referrers"],
    summary: "Get all referrers for the lab",
  },
};

const createReferrerSchema = {
  schema: {
    tags: ["Referrers"],
    summary: "Add a new referrer to the lab",
    body: {
      type: "object",
      required: ["name", "contactNumber", "type", "commissionType", "commissionValue"],
      additionalProperties: false,
      properties: referrerBodyProperties,
    },
  },
};

// Basic-info edit only. commissionType/commissionValue are intentionally
// absent — commission has its own dedicated route (mirrors the frontend,
// which edits it in a separate modal).
const updateReferrerSchema = {
  schema: {
    tags: ["Referrers"],
    summary: "Update a referrer's basic info",
    params: referrerIdParamSchema,
    body: {
      type: "object",
      required: [],
      additionalProperties: false,
      minProperties: 1,
      description: "At least one field must be provided",
      properties: {
        name: referrerBodyProperties.name,
        contactNumber: referrerBodyProperties.contactNumber,
        degree: referrerBodyProperties.degree,
        details: referrerBodyProperties.details,
        type: referrerBodyProperties.type,
      },
    },
  },
};

// Dedicated route for commission edits only.
const updateCommissionSchema = {
  schema: {
    tags: ["Referrers"],
    summary: "Update a referrer's commission",
    params: referrerIdParamSchema,
    body: {
      type: "object",
      required: ["commissionType", "commissionValue"],
      additionalProperties: false,
      properties: {
        commissionType: referrerBodyProperties.commissionType,
        commissionValue: referrerBodyProperties.commissionValue,
      },
    },
  },
};

const deleteReferrerSchema = {
  schema: {
    tags: ["Referrers"],
    summary: "Hard delete a referrer",
    params: referrerIdParamSchema,
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

async function referrerRoutes(fastify) {
  const collection = fastify.mongo.db.collection(collectionName);
  const labsCollection = fastify.mongo.db.collection("labs");
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("onRequest", fastify.authorize("manageReferrers"));

  // ── GET /referrers ────────────────────────────────────────────────────────
  fastify.get("/referrers", getAllReferrersSchema, async (req, reply) => {
    try {
      const lid = labId(req);
      const [referrers, lab] = await Promise.all([
        collection.find({ labId: lid }).sort({ name: 1 }).toArray(),
        labsCollection.findOne({ _id: lid }, { projection: { "limit.maxReferrer": 1 } }),
      ]);

      return { referrers, maxReferrer: typeof lab?.limit?.maxReferrer === "number" ? lab.limit.maxReferrer : null };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch referrers" });
    }
  });

  // ── POST /referrer/add ────────────────────────────────────────────────────
  fastify.post("/referrer/add", createReferrerSchema, async (req, reply) => {
    try {
      const lid = labId(req);

      // ── Referrer limit check ────────────────────────────────────────────
      // Authoritative gate — the frontend also disables its "New Referrer"
      // button once the limit is reached, but that's UX only. No "upgrade"
      // messaging here; the plan doesn't self-serve this limit, so the
      // message points the admin to contact support instead.
      const lab = await labsCollection.findOne({ _id: lid }, { projection: { "limit.maxReferrer": 1 } });
      const maxReferrer = lab?.limit?.maxReferrer;

      if (typeof maxReferrer === "number") {
        const currentCount = await collection.countDocuments({ labId: lid });
        if (currentCount >= maxReferrer) {
          return reply.code(403).send({
            error: `আপনার ল্যাবে সর্বোচ্চ ${maxReferrer} জন রেফারার যোগ করা যাবে। সীমা পূর্ণ হয়েছে। সীমা বাড়াতে আমাদের সাথে যোগাযোগ করুন।`,
            code: "REFERRER_LIMIT_REACHED",
            limit: maxReferrer,
            current: currentCount,
          });
        }
      }

      const { name, contactNumber, degree, details, type, commissionType, commissionValue } = req.body;

      if (commissionType === "percentage" && commissionValue > 100) {
        return reply.code(400).send({ error: "Percentage must be between 0 and 100" });
      }

      const result = await collection.insertOne({
        labId: lid,
        name,
        contactNumber,
        degree,
        details,
        type,
        commissionType,
        commissionValue,
        created: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
      });
      return reply.code(201).send({ _id: result.insertedId });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to create referrer" });
    }
  });

  // ── PUT /referrer/edit/:id ────────────────────────────────────────────────
  fastify.put("/referrer/edit/:id", updateReferrerSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid referrer ID" });

      const { name, contactNumber, degree, details, type } = req.body;

      const updateData = {
        ...(name !== undefined && { name }),
        ...(contactNumber !== undefined && { contactNumber }),
        ...(degree !== undefined && { degree }),
        ...(details !== undefined && { details }),
        ...(type !== undefined && { type }),
        updated: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
      };

      const result = await collection.updateOne({ _id, labId: labId(req) }, { $set: updateData });
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Referrer not found" });

      return { message: "Referrer updated successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update referrer" });
    }
  });

  // ── PUT /referrer/:id/commission ──────────────────────────────────────────
  fastify.put("/referrer/:id/commission", updateCommissionSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid referrer ID" });

      const { commissionType, commissionValue } = req.body;

      if (commissionType === "percentage" && commissionValue > 100) {
        return reply.code(400).send({ error: "Percentage must be between 0 and 100" });
      }

      const result = await collection.updateOne(
        { _id, labId: labId(req) },
        {
          $set: {
            commissionType,
            commissionValue,
            updated: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
          },
        },
      );
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Referrer not found" });

      return { message: "Commission updated successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update commission" });
    }
  });

  // ── DELETE /referrer/:id ──────────────────────────────────────────────────
  fastify.delete("/referrer/:id", deleteReferrerSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid referrer ID" });

      const result = await collection.deleteOne({ _id, labId: labId(req) });
      if (result.deletedCount === 0) return reply.code(404).send({ error: "Referrer not found" });
      return { message: "Referrer deleted successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to delete referrer" });
    }
  });
}

export default referrerRoutes;
