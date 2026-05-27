/**
 * spaces.routes.js
 * Fastify routes for Indoor Patient Spaces (Wards / Cabins / ICU etc.)
 *
 * Schema shape (MongoDB document):
 * {
 *   _id          : ObjectId,
 *   labId        : ObjectId,
 *   name         : String,
 *   chargePerDay : Number,
 *   department   : String,
 *   multiBed     : Boolean,
 *
 *   // single-bed reservation
 *   reserved     : Boolean,        // only when multiBed=false
 *   reservedNote : String,         // only when multiBed=false
 *
 *   multiBedConf : {               // null when multiBed=false
 *     totalNumberOfBed : Number,
 *     bedStartingNumber: Number,
 *     booked   : [Number],         // managed externally via invoice flow
 *     reserved : [{ bedNumber: Number, note: String }],
 *   },
 *
 *   created : { at: Number, by: { id, name } },
 *   updated : { at: Number, by: { id, name } },
 * }
 */

import toObjectId from "../../utils/db.js";

const COLLECTION = "admissionSpaces";

const DEPARTMENTS = [
  "general",
  "cardiology",
  "orthopedics",
  "neurology",
  "gynecology",
  "pediatrics",
  "icu",
  "oncology",
  "surgery",
  "urology",
  "mio",
  "other",
];

// ─── Reusable Schema Fragments ────────────────────────────────────────────────

const objectIdSchema = { type: "string", minLength: 24, maxLength: 24 };

const spaceIdParamSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { ...objectIdSchema, description: "ObjectId of the space" } },
};

const multiBedConfSchema = {
  type: "object",
  required: ["totalNumberOfBed", "bedStartingNumber"],
  additionalProperties: false,
  properties: {
    totalNumberOfBed: { type: "integer", minimum: 1 },
    bedStartingNumber: { type: "integer", minimum: 0 },
    booked: { type: "array", items: { type: "integer" } },
    reserved: {
      type: "array",
      items: {
        type: "object",
        required: ["bedNumber"],
        additionalProperties: false,
        properties: {
          bedNumber: { type: "integer", minimum: 0 },
          note: { type: "string", maxLength: 300 },
        },
      },
    },
  },
};

const spaceBodyProperties = {
  name: { type: "string", minLength: 1, maxLength: 100 },
  chargePerDay: { type: "number", minimum: 0 },
  department: { type: "string", enum: DEPARTMENTS },
  multiBed: { type: "boolean" },
  multiBedConf: { oneOf: [multiBedConfSchema, { type: "null" }] },
};

// ─── Route Schemas ────────────────────────────────────────────────────────────

const getAllSpacesSchema = {
  schema: {
    tags: ["Spaces"],
    summary: "Get all spaces for the lab",
    querystring: {
      type: "object",
      properties: {
        department: { type: "string", enum: [...DEPARTMENTS, "all"] },
      },
    },
  },
};

const getSpaceByIdSchema = {
  schema: { tags: ["Spaces"], summary: "Get a single space by ID", params: spaceIdParamSchema },
};

const createSpaceSchema = {
  schema: {
    tags: ["Spaces"],
    summary: "Create a new space",
    body: {
      type: "object",
      required: ["name", "chargePerDay", "department", "multiBed"],
      additionalProperties: false,
      properties: spaceBodyProperties,
    },
  },
};

const updateSpaceSchema = {
  schema: {
    tags: ["Spaces"],
    summary: "Update a space",
    params: spaceIdParamSchema,
    body: {
      type: "object",
      minProperties: 1,
      additionalProperties: false,
      properties: spaceBodyProperties,
    },
  },
};

const deleteSpaceSchema = {
  schema: { tags: ["Spaces"], summary: "Hard-delete a space", params: spaceIdParamSchema },
};

// ── Reservation schemas ───────────────────────────────────────────────────────

const reserveSingleSchema = {
  schema: {
    tags: ["Spaces"],
    summary: "Reserve a single-bed space",
    params: spaceIdParamSchema,
    body: {
      type: "object",
      additionalProperties: false,
      properties: { note: { type: "string", maxLength: 300 } },
    },
  },
};

const releaseSingleReservationSchema = {
  schema: {
    tags: ["Spaces"],
    summary: "Release reservation on a single-bed space",
    params: spaceIdParamSchema,
  },
};

const reserveBedSchema = {
  schema: {
    tags: ["Spaces"],
    summary: "Reserve a specific bed in a multi-bed space",
    params: spaceIdParamSchema,
    body: {
      type: "object",
      required: ["bedNumber"],
      additionalProperties: false,
      properties: {
        bedNumber: { type: "integer", minimum: 0 },
        note: { type: "string", maxLength: 300 },
      },
    },
  },
};

const releaseBedReservationSchema = {
  schema: {
    tags: ["Spaces"],
    summary: "Release reservation on a specific bed",
    params: spaceIdParamSchema,
    body: {
      type: "object",
      required: ["bedNumber"],
      additionalProperties: false,
      properties: { bedNumber: { type: "integer", minimum: 0 } },
    },
  },
};

// ─── Route Plugin ─────────────────────────────────────────────────────────────

async function admissionSpaceRoutes(fastify) {
  const col = () => fastify.mongo.db.collection(COLLECTION);
  const labId = (req) => toObjectId(req.user.labId);
  const by = (req) => ({ id: req.user.id, name: req.user.name });
  const now = () => Date.now();

  fastify.addHook("onRequest", fastify.authenticate);

  // ── GET /spaces ─────────────────────────────────────────────────────────────
  fastify.get("/spaces", getAllSpacesSchema, async (req, reply) => {
    try {
      const filter = { labId: labId(req) };
      if (req.query.department && req.query.department !== "all") {
        filter.department = req.query.department;
      }
      return col().find(filter).sort({ name: 1 }).toArray();
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch spaces" });
    }
  });

  // ── GET /space/:id ──────────────────────────────────────────────────────────
  fastify.get("/space/:id", getSpaceByIdSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid space ID" });
      const space = await col().findOne({ _id, labId: labId(req) });
      if (!space) return reply.code(404).send({ error: "Space not found" });
      return space;
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch space" });
    }
  });

  // ── POST /space/add ─────────────────────────────────────────────────────────
  fastify.post("/space/add", createSpaceSchema, async (req, reply) => {
    try {
      const { name, chargePerDay, department, multiBed, multiBedConf } = req.body;

      if (multiBed && !multiBedConf) {
        return reply.code(400).send({ error: "multiBedConf is required when multiBed is true" });
      }

      if (multiBed && multiBedConf) {
        const { totalNumberOfBed, bedStartingNumber, booked = [] } = multiBedConf;
        const inRange = (b) => b >= bedStartingNumber && b < bedStartingNumber + totalNumberOfBed;
        if (!booked.every(inRange)) {
          return reply.code(400).send({ error: "Booked bed numbers are out of range" });
        }
      }

      const trimmedName = name.trim();
      const existing = await col().findOne({ labId: labId(req), name: trimmedName });
      if (existing) return reply.code(409).send({ error: "A space with this name already exists" });

      const doc = {
        labId: labId(req),
        name: trimmedName,
        chargePerDay,
        department,
        multiBed,
        ...(multiBed
          ? {
              multiBedConf: {
                ...multiBedConf,
                booked: multiBedConf.booked ?? [],
                reserved: multiBedConf.reserved ?? [],
              },
            }
          : {
              multiBedConf: null,
              reserved: false,
              reservedNote: "",
            }),
        created: { at: now(), by: by(req) },
      };

      const result = await col().insertOne(doc);
      return reply.code(201).send({ _id: result.insertedId });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to create space" });
    }
  });

  // ── PUT /space/edit/:id ─────────────────────────────────────────────────────
  fastify.put("/space/edit/:id", updateSpaceSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid space ID" });

      const { name, chargePerDay, department, multiBed, multiBedConf } = req.body;

      const resolvedMultiBedConf =
        multiBed === false
          ? null
          : multiBed === true && multiBedConf
            ? { ...multiBedConf, booked: multiBedConf.booked ?? [], reserved: multiBedConf.reserved ?? [] }
            : undefined;

      const $set = {
        ...(name !== undefined && { name: name.trim() }),
        ...(chargePerDay !== undefined && { chargePerDay }),
        ...(department !== undefined && { department }),
        ...(multiBed !== undefined && { multiBed }),
        ...(resolvedMultiBedConf !== undefined && { multiBedConf: resolvedMultiBedConf }),
        ...(multiBed === false && { reserved: false, reservedNote: "" }),
        updated: { at: now(), by: by(req) },
      };

      const result = await col().updateOne({ _id, labId: labId(req) }, { $set });
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Space not found" });
      return { message: "Space updated successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update space" });
    }
  });

  // ── DELETE /space/:id ───────────────────────────────────────────────────────
  fastify.delete("/space/:id", deleteSpaceSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid space ID" });
      const result = await col().deleteOne({ _id, labId: labId(req) });
      if (result.deletedCount === 0) return reply.code(404).send({ error: "Space not found" });
      return { message: "Space deleted successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to delete space" });
    }
  });

  // ── PATCH /space/:id/reserve — single-bed ───────────────────────────────────
  fastify.patch("/space/:id/reserve", reserveSingleSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid space ID" });

      const space = await col().findOne({ _id, labId: labId(req) });
      if (!space) return reply.code(404).send({ error: "Space not found" });
      if (space.multiBed) return reply.code(400).send({ error: "Use /reserve-bed for multi-bed spaces" });
      if (space.reserved) return reply.code(409).send({ error: "Space is already reserved" });

      await col().updateOne(
        { _id, labId: labId(req) },
        { $set: { reserved: true, reservedNote: req.body.note ?? "", updated: { at: now(), by: by(req) } } },
      );
      return { message: "Space reserved successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to reserve space" });
    }
  });

  // ── PATCH /space/:id/release-reservation — single-bed ───────────────────────
  fastify.patch("/space/:id/release-reservation", releaseSingleReservationSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid space ID" });

      const space = await col().findOne({ _id, labId: labId(req) });
      if (!space) return reply.code(404).send({ error: "Space not found" });
      if (space.multiBed) return reply.code(400).send({ error: "Use /release-bed-reservation for multi-bed spaces" });
      if (!space.reserved) return reply.code(400).send({ error: "Space is not currently reserved" });

      await col().updateOne(
        { _id, labId: labId(req) },
        { $set: { reserved: false, reservedNote: "", updated: { at: now(), by: by(req) } } },
      );
      return { message: "Reservation released successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to release reservation" });
    }
  });

  // ── PATCH /space/:id/reserve-bed — multi-bed ────────────────────────────────
  fastify.patch("/space/:id/reserve-bed", reserveBedSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid space ID" });

      const space = await col().findOne({ _id, labId: labId(req) });
      if (!space) return reply.code(404).send({ error: "Space not found" });
      if (!space.multiBed || !space.multiBedConf) {
        return reply.code(400).send({ error: "Space is not a multi-bed space" });
      }

      const { bedNumber, note = "" } = req.body;
      const { totalNumberOfBed, bedStartingNumber, booked = [], reserved = [] } = space.multiBedConf;

      if (bedNumber < bedStartingNumber || bedNumber >= bedStartingNumber + totalNumberOfBed) {
        return reply.code(400).send({ error: "Bed number out of range" });
      }
      if (booked.includes(bedNumber)) {
        return reply.code(409).send({ error: "Bed is already booked" });
      }
      if (reserved.some((r) => r.bedNumber === bedNumber)) {
        return reply.code(409).send({ error: "Bed is already reserved" });
      }

      await col().updateOne(
        { _id, labId: labId(req) },
        {
          $push: { "multiBedConf.reserved": { bedNumber, note } },
          $set: { updated: { at: now(), by: by(req) } },
        },
      );
      return { message: `Bed ${bedNumber} reserved successfully` };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to reserve bed" });
    }
  });

  // ── PATCH /space/:id/release-bed-reservation — multi-bed ────────────────────
  fastify.patch("/space/:id/release-bed-reservation", releaseBedReservationSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid space ID" });

      const space = await col().findOne({ _id, labId: labId(req) });
      if (!space) return reply.code(404).send({ error: "Space not found" });
      if (!space.multiBed || !space.multiBedConf) {
        return reply.code(400).send({ error: "Space is not a multi-bed space" });
      }

      const { bedNumber } = req.body;
      if (!space.multiBedConf.reserved?.some((r) => r.bedNumber === bedNumber)) {
        return reply.code(400).send({ error: "Bed is not currently reserved" });
      }

      await col().updateOne(
        { _id, labId: labId(req) },
        {
          $pull: { "multiBedConf.reserved": { bedNumber } },
          $set: { updated: { at: now(), by: by(req) } },
        },
      );
      return { message: `Bed ${bedNumber} reservation released` };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to release bed reservation" });
    }
  });
}

export default admissionSpaceRoutes;
