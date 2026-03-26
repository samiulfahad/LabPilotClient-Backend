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
  isActive: { type: "boolean", description: "Whether the referrer is active (defaults to true)" },
};

// ─── Route Schemas ────────────────────────────────────────────────────────────

const getAllReferrersSchema = {
  schema: {
    tags: ["Referrers"],
    summary: "Get all referrers for the lab",
  },
};

const getReferrerByIdSchema = {
  schema: {
    tags: ["Referrers"],
    summary: "Get a single referrer by ID",
    params: referrerIdParamSchema,
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

const updateReferrerSchema = {
  schema: {
    tags: ["Referrers"],
    summary: "Update an existing referrer",
    params: referrerIdParamSchema,
    body: {
      type: "object",
      required: [],
      additionalProperties: false,
      minProperties: 1,
      description: "At least one field must be provided",
      properties: referrerBodyProperties,
    },
  },
};

const deactivateReferrerSchema = {
  schema: {
    tags: ["Referrers"],
    summary: "Deactivate a referrer",
    params: referrerIdParamSchema,
  },
};

const activateReferrerSchema = {
  schema: {
    tags: ["Referrers"],
    summary: "Activate a referrer",
    params: referrerIdParamSchema,
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

async function routes(fastify, options) {
  const collection = fastify.mongo.db.collection(collectionName);
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);

  // ── GET /referrers ────────────────────────────────────────────────────────
  fastify.get("/referrers", getAllReferrersSchema, async (req, reply) => {
    try {
      return collection
        .find({ labId: labId(req) })
        .sort({ name: 1 })
        .toArray();
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch referrers" });
    }
  });

  // ── GET /referrer/:id ─────────────────────────────────────────────────────
  fastify.get("/referrer/:id", getReferrerByIdSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid referrer ID" });

      const referrer = await collection.findOne({ _id, labId: labId(req) });
      if (!referrer) return reply.code(404).send({ error: "Referrer not found" });
      return referrer;
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch referrer" });
    }
  });

  // ── POST /referrer/add ────────────────────────────────────────────────────
  fastify.post("/referrer/add", createReferrerSchema, async (req, reply) => {
    try {
      const { formType, _id, ...data } = req.body;

      if (data.commissionType === "percentage" && data.commissionValue > 100) {
        return reply.code(400).send({ error: "Percentage must be between 0 and 100" });
      }

      const result = await collection.insertOne({
        ...data,
        labId: labId(req),
        isActive: data.isActive ?? true,
        created: { at: Date.now(), by: { id: req.user.id, name: req.user.name } },
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

      const { formType, _id: bodyId, ...data } = req.body;

      if (data.commissionType === "percentage" && data.commissionValue > 100) {
        return reply.code(400).send({ error: "Percentage must be between 0 and 100" });
      }

      data.updated = { at: Date.now(), by: { id: req.user.id, name: req.user.name } };

      const result = await collection.updateOne({ _id, labId: labId(req) }, { $set: data });
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Referrer not found" });

      return { message: "Referrer updated successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update referrer" });
    }
  });

  // ── PATCH /referrer/:id/deactivate ────────────────────────────────────────
  fastify.patch("/referrer/:id/deactivate", deactivateReferrerSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid referrer ID" });

      const result = await collection.updateOne(
        { _id, labId: labId(req) },
        { $set: { isActive: false, updated: { at: Date.now(), by: { id: req.user.id, name: req.user.name } } } },
      );
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Referrer not found" });
      return { message: "Referrer deactivated successfully", _id: req.params.id };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to deactivate referrer" });
    }
  });

  // ── PATCH /referrer/:id/activate ──────────────────────────────────────────
  fastify.patch("/referrer/:id/activate", activateReferrerSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid referrer ID" });

      const result = await collection.updateOne(
        { _id, labId: labId(req) },
        { $set: { isActive: true, updated: { at: Date.now(), by: { id: req.user.id, name: req.user.name } } } },
      );
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Referrer not found" });
      return { message: "Referrer activated successfully", _id: req.params.id };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to activate referrer" });
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

export default routes;
