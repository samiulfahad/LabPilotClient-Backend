import bcrypt from "bcryptjs";
import toObjectId from "../../utils/db.js";
import generateInvoiceId from "../../utils/generateInvoiceId.js";
import { ALLOWED_PERMISSIONS } from "../staticData/staticData.js";

const collectionName = "staffs";
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Reusable Schema Fragments ────────────────────────────────────────────────

const objectIdSchema = {
  type: "string",
  minLength: 24,
  maxLength: 24,
  description: "MongoDB ObjectId (24-character hex string)",
};

const staffIdParamSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { ...objectIdSchema, description: "ObjectId of the staff member" },
  },
};

// ─── Body Properties ──────────────────────────────────────────────────────────

const permissionsSchema = {
  type: "object",
  description: "Staff permissions",
  properties: Object.fromEntries(ALLOWED_PERMISSIONS.map((p) => [p.key, { type: "boolean" }])),
  additionalProperties: false,
};

const staffBodyProperties = {
  name: { type: "string", minLength: 1, maxLength: 100, description: "Full name" },
  email: {
    anyOf: [
      { type: "string", minLength: 5, maxLength: 254 },
      { type: "string", maxLength: 0 },
    ],
    description: "Unique email address (optional)",
  },
  phone: { type: "string", minLength: 10, maxLength: 15, description: "Unique phone number" },
  permissions: permissionsSchema,
  maxLabAdjustment: {
    type: "number",
    minimum: 0,
    description: "Max amount this staff can apply as a lab/bill adjustment (0 = disabled)",
  },
};

// ─── Route Schemas ────────────────────────────────────────────────────────────

const getAllStaffSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Get all staff for the lab",
  },
};

// maxLabAdjustment is optional here (defaults to 0 in the handler if omitted)
// so it can be set at registration time instead of requiring the separate
// PUT /staff/:id/adjustment route right after.
const createStaffSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Add a new staff member to the lab",
    body: {
      type: "object",
      required: ["name", "phone", "permissions"],
      additionalProperties: false,
      properties: staffBodyProperties,
    },
  },
};

// Dedicated route for permission edits only. name/email/phone are fixed at
// registration (mirrors the frontend, which hides those inputs entirely on
// edit) — they're absent from this schema's properties, so
// additionalProperties:false rejects them outright even via a direct API call.
const updatePermissionsSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Update a staff member's permissions",
    params: staffIdParamSchema,
    body: {
      type: "object",
      required: ["permissions"],
      additionalProperties: false,
      properties: {
        permissions: staffBodyProperties.permissions,
      },
    },
  },
};

// Dedicated route for the lab/bill adjustment limit only — still used to
// change the limit after a staff member already exists.
const updateAdjustmentSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Update a staff member's max lab/bill adjustment limit",
    params: staffIdParamSchema,
    body: {
      type: "object",
      required: ["maxLabAdjustment"],
      additionalProperties: false,
      properties: {
        maxLabAdjustment: staffBodyProperties.maxLabAdjustment,
      },
    },
  },
};

const deactivateStaffSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Deactivate a staff member",
    params: staffIdParamSchema,
  },
};

const activateStaffSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Activate a staff member",
    params: staffIdParamSchema,
  },
};

const deleteStaffSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Soft delete a staff member",
    params: staffIdParamSchema,
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Derived from ALLOWED_PERMISSIONS so it never drifts out of sync
const normalizePermissions = (perms = {}) =>
  Object.fromEntries(ALLOWED_PERMISSIONS.map((p) => [p.key, perms[p.key] ?? false]));

// ─── Routes ───────────────────────────────────────────────────────────────────

async function staffRoutes(fastify) {
  const collection = fastify.mongo.db.collection(collectionName);
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("onRequest", fastify.requireAdmin);

  // ── Scoped duplicate checker ──────────────────────────────────────────────
  const checkDuplicate = async (req, field, value, excludeId = null) => {
    const query = {
      [field]: value,
      labId: labId(req),
      "deletion.status": { $ne: true },
    };
    if (excludeId) query._id = { $ne: toObjectId(excludeId) };
    return collection.findOne(query, { projection: { _id: 1 } });
  };

  // Shared guard used by both edit routes: staff must exist in this lab and
  // must not be an admin account (admins always have fixed, full access).
  const findEditableStaff = async (req, reply) => {
    const _id = toObjectId(req.params.id);
    if (!_id) {
      reply.code(400).send({ error: "Invalid staff ID" });
      return null;
    }
    const existing = await collection.findOne(
      { _id, labId: labId(req), "deletion.status": { $ne: true } },
      { projection: { role: 1 } },
    );
    if (!existing) {
      reply.code(404).send({ error: "Staff not found" });
      return null;
    }
    if (existing.role === "admin") {
      reply.code(403).send({ error: "Admin accounts cannot be edited" });
      return null;
    }
    return _id;
  };

  // ── GET /staffs ───────────────────────────────────────────────────────────
  fastify.get("/staffs", getAllStaffSchema, async (req, reply) => {
    try {
      return collection
        .find(
          { labId: labId(req), "deletion.status": { $ne: true } },
          {
            projection: {
              name: 1,
              email: 1,
              phone: 1,
              permissions: 1,
              isActive: 1,
              role: 1,
              deletion: 1,
              maxLabAdjustment: 1,
            },
          },
        )
        .sort({ name: 1 })
        .toArray();
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch staff" });
    }
  });

  // ── POST /staff/add ───────────────────────────────────────────────────────
  fastify.post("/staff/add", createStaffSchema, async (req, reply) => {
    try {
      const { name, email: rawEmail, phone: rawPhone, permissions, maxLabAdjustment } = req.body;

      const email = rawEmail?.trim() ? rawEmail.toLowerCase().trim() : null;
      const phone = rawPhone.trim();

      if (email) {
        if (!EMAIL_REGEX.test(email)) {
          return reply.code(400).send({ error: "Invalid email format" });
        }
        if (await checkDuplicate(req, "email", email)) {
          return reply.code(409).send({ error: "Email already exists in this lab" });
        }
      }

      if (await checkDuplicate(req, "phone", phone)) {
        return reply.code(409).send({ error: "Phone number already exists in this lab" });
      }

      const password = generateInvoiceId();
      const hashedPassword = await bcrypt.hash(password, 10);

      const result = await collection.insertOne({
        labId: labId(req),
        labKey: String(req.user.labKey),
        name: name.trim(),
        ...(email && { email }),
        phone,
        password: hashedPassword,
        role: "staff",
        permissions: normalizePermissions(permissions),
        isActive: true,
        maxLabAdjustment: maxLabAdjustment ?? 0,
        deletion: { status: false, at: null, by: null },
        created: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
      });

      const message = `LabPilotPro.com-এ আপনাকে স্বাগতম। আপনার পাসওয়ার্ড ${password} এবং ল্যাব আইডি ${req.user.labKey} , লগইন করার পর পাসওয়ার্ডটি পরিবর্তন করুন`;

      fastify.sendSMS({ number: phone, message });

      return reply.code(201).send({ _id: result.insertedId });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to create staff member" });
    }
  });

  // ── PUT /staff/:id/permissions ────────────────────────────────────────────
  fastify.put("/staff/:id/permissions", updatePermissionsSchema, async (req, reply) => {
    try {
      const _id = await findEditableStaff(req, reply);
      if (!_id) return;

      await collection.updateOne(
        { _id, labId: labId(req), "deletion.status": { $ne: true } },
        {
          $set: {
            permissions: normalizePermissions(req.body.permissions),
            updated: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
          },
        },
      );

      await fastify.mongo.db.collection("tokens").deleteMany({ userId: _id });

      return { message: "Permissions updated successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update permissions" });
    }
  });

  // ── PUT /staff/:id/adjustment ──────────────────────────────────────────────
  fastify.put("/staff/:id/adjustment", updateAdjustmentSchema, async (req, reply) => {
    try {
      const _id = await findEditableStaff(req, reply);
      if (!_id) return;

      await collection.updateOne(
        { _id, labId: labId(req), "deletion.status": { $ne: true } },
        {
          $set: {
            maxLabAdjustment: req.body.maxLabAdjustment,
            updated: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
          },
        },
      );

      return { message: "Adjustment limit updated successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update adjustment limit" });
    }
  });

  // ── PATCH /staff/:id/deactivate ───────────────────────────────────────────
  fastify.patch("/staff/:id/deactivate", deactivateStaffSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid staff ID" });

      const result = await collection.updateOne(
        { _id, labId: labId(req), "deletion.status": { $ne: true } },
        {
          $set: {
            isActive: false,
            updated: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
          },
        },
      );
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Staff not found" });

      // Kill all active sessions for this staff member — a deactivated
      // account shouldn't be able to keep using an already-issued refresh
      // token until it naturally expires.
      await fastify.mongo.db.collection("tokens").deleteMany({ userId: _id });

      return { message: "Staff deactivated successfully", _id: req.params.id };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to deactivate staff member" });
    }
  });

  // ── PATCH /staff/:id/activate ─────────────────────────────────────────────
  fastify.patch("/staff/:id/activate", activateStaffSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid staff ID" });

      const result = await collection.updateOne(
        { _id, labId: labId(req), "deletion.status": { $ne: true } },
        {
          $set: {
            isActive: true,
            updated: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
          },
        },
      );
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Staff not found" });
      return { message: "Staff activated successfully", _id: req.params.id };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to activate staff member" });
    }
  });

  // ── DELETE /staff/:id ─────────────────────────────────────────────────────
  fastify.delete("/staff/:id", deleteStaffSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid staff ID" });

      const result = await collection.updateOne(
        { _id, labId: labId(req), "deletion.status": { $ne: true } },
        {
          $set: {
            deletion: {
              status: true,
              at: Date.now(),
              by: { id: toObjectId(req.user.id), name: req.user.name },
            },
          },
        },
      );
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Staff not found" });
      return { message: "Staff deleted successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to delete staff member" });
    }
  });
}

export default staffRoutes;
