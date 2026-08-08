/**
 * spaces.routes.js
 * Fastify routes for Indoor Patient Spaces (Wards / Cabins / ICU etc.)
 *
 * Schema shape (MongoDB document):
 * {
 *   _id          : ObjectId,
 *   labId        : ObjectId,
 *   name         : String,
 *   chargePerDay : Number,         // set on create, changed only via /price
 *   departments  : [String],       // array, min 1 item
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
 *
 * LIMIT CHECK (added): GET /spaces now returns { spaces, maxAdmissionSpace }
 * instead of a bare array. POST /space/add enforces lab.limit.maxAdmissionSpace
 * as the authoritative gate, same pattern as maxDoctor in doctorRoutes.js and
 * maxReferrer in referrerRoutes.js.
 */

import toObjectId from "../../utils/db.js";
import { ALLOWED_DEPARTMENTS } from "../staticData/staticData.js";

const COLLECTION = "admissionSpaces";

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

// departments driven by the canonical list from departmentRoutes
const departmentsSchema = {
  type: "array",
  items: { type: "string", enum: [...ALLOWED_DEPARTMENTS] },
  minItems: 1,
  uniqueItems: true,
};

// Fields shared between create/update. `chargePerDay` is intentionally NOT
// part of this shared set — it's only settable at creation time and from
// then on only through the dedicated /price route (same split as
// commissionType/commissionValue on referrers, which have their own route
// and are excluded from the general referrer update schema).
const spaceCoreProperties = {
  name: { type: "string", minLength: 1, maxLength: 100 },
  departments: departmentsSchema,
  multiBed: { type: "boolean" },
  multiBedConf: { oneOf: [multiBedConfSchema, { type: "null" }] },
};

// ─── Route Schemas ────────────────────────────────────────────────────────────

const getAllSpacesSchema = {
  schema: {
    tags: ["Spaces"],
    summary: "Get all spaces for the lab (with maxAdmissionSpace limit)",
    querystring: {
      type: "object",
      properties: {
        department: { type: "string", enum: [...ALLOWED_DEPARTMENTS, "all"] },
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
      required: ["name", "chargePerDay", "departments", "multiBed"],
      additionalProperties: false,
      properties: {
        ...spaceCoreProperties,
        chargePerDay: { type: "number", minimum: 0 },
      },
    },
  },
};

// chargePerDay deliberately excluded — see /space/:id/price below.
const updateSpaceSchema = {
  schema: {
    tags: ["Spaces"],
    summary: "Update a space's basic info",
    params: spaceIdParamSchema,
    body: {
      type: "object",
      minProperties: 1,
      additionalProperties: false,
      properties: spaceCoreProperties,
    },
  },
};

// Dedicated route for price edits only — same pattern as
// PUT /referrer/:id/commission.
const updatePriceSchema = {
  schema: {
    tags: ["Spaces"],
    summary: "Update a space's price (charge per day)",
    params: spaceIdParamSchema,
    body: {
      type: "object",
      required: ["chargePerDay"],
      additionalProperties: false,
      properties: { chargePerDay: { type: "number", minimum: 0 } },
    },
  },
};

const deleteSpaceSchema = {
  schema: { tags: ["Spaces"], summary: "Hard-delete a space", params: spaceIdParamSchema },
};

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Coerces the lab's maxAdmissionSpace limit field to a number regardless of
// whether it's stored as NumberInt or a string. Returns null for "no limit
// set" (missing, null, or non-numeric) — mirrors parseMaxDoctor in
// doctorRoutes.js.
const parseMaxAdmissionSpace = (rawMax) => {
  if (rawMax === undefined || rawMax === null) return null;
  const n = Number(rawMax);
  return isNaN(n) ? null : n;
};

// ─── Route Plugin ─────────────────────────────────────────────────────────────

async function admissionSpaceRoutes(fastify) {
  const col = () => fastify.mongo.db.collection(COLLECTION);
  const labsCollection = fastify.mongo.db.collection("labs");
  const labId = (req) => toObjectId(req.user.labId);
  const by = (req) => ({ id: toObjectId(req.user.id), name: req.user.name });
  const now = () => Date.now();

  fastify.addHook("onRequest", fastify.authenticate);
  // IPD is a hospital-only module — diagnosticCenter labs must never reach these routes,
  // mirroring the isHospital guard pattern used in cashmemo/commissionReport/salesReport routes.
  fastify.addHook("onRequest", async (req, reply) => {
    if (req.user.type !== "hospital") {
      return reply.code(403).send({ error: "Indoor patient management is only available for hospital labs" });
    }
  });
  fastify.addHook("onRequest", fastify.authorize("manageAdmissionSpace"));

  // ── GET /spaces ─────────────────────────────────────────────────────────────
  fastify.get("/spaces", getAllSpacesSchema, async (req, reply) => {
    try {
      const filter = { labId: labId(req) };
      if (req.query.department && req.query.department !== "all") {
        // also handles legacy docs that stored a singular `department` string
        filter.$or = [{ departments: req.query.department }, { department: req.query.department }];
      }

      const [spaces, lab] = await Promise.all([
        col().find(filter).sort({ name: 1 }).toArray(),
        labsCollection.findOne({ _id: labId(req) }, { projection: { "limit.maxAdmissionSpace": 1 } }),
      ]);

      const maxAdmissionSpace = parseMaxAdmissionSpace(lab?.limit?.maxAdmissionSpace);

      return reply.send({ spaces, maxAdmissionSpace });
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
      const { name, chargePerDay, departments, multiBed, multiBedConf } = req.body;

      // ── Admission space limit check ─────────────────────────────────────
      // Authoritative gate — the frontend also disables its "New" button
      // once the limit is reached, but that's UX only.
      const lab = await labsCollection.findOne({ _id: labId(req) }, { projection: { "limit.maxAdmissionSpace": 1 } });
      const maxAdmissionSpace = parseMaxAdmissionSpace(lab?.limit?.maxAdmissionSpace);

      if (maxAdmissionSpace !== null) {
        const currentCount = await col().countDocuments({ labId: labId(req) });
        if (currentCount >= maxAdmissionSpace) {
          return reply.code(403).send({
            error: `আপনার ল্যাবে সর্বোচ্চ ${maxAdmissionSpace}টি কক্ষ/স্থান যোগ করা যাবে। সীমা পূর্ণ হয়েছে। সীমা বাড়াতে আমাদের সাথে যোগাযোগ করুন।`,
            code: "ADMISSION_SPACE_LIMIT_REACHED",
            limit: maxAdmissionSpace,
            current: currentCount,
          });
        }
      }

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
        departments,
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

  // ── PUT /space/edit/:id — basic info only, no price ─────────────────────────
  fastify.put("/space/edit/:id", updateSpaceSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid space ID" });

      const { name, departments, multiBed, multiBedConf } = req.body;

      const resolvedMultiBedConf =
        multiBed === false
          ? null
          : multiBed === true && multiBedConf
            ? { ...multiBedConf, booked: multiBedConf.booked ?? [], reserved: multiBedConf.reserved ?? [] }
            : undefined;

      const $set = {
        ...(name !== undefined && { name: name.trim() }),
        ...(departments !== undefined && { departments }),
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

  // ── PATCH /space/:id/price ──────────────────────────────────────────────────
  fastify.patch("/space/:id/price", updatePriceSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid space ID" });

      const { chargePerDay } = req.body;

      const result = await col().updateOne(
        { _id, labId: labId(req) },
        { $set: { chargePerDay, updated: { at: now(), by: by(req) } } },
      );
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Space not found" });
      return { message: "Price updated successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update price" });
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
