import bcrypt from "bcryptjs";
import crypto from "crypto";
import toObjectId from "../../utils/db.js";
import { ALLOWED_PERMISSIONS } from "../staticData/staticData.js";

const collectionName = "staffs";
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * MIGRATION NOTE — soft delete → hard delete (see audit):
 * DELETE /staff/:id previously flipped a `deletion.status` flag instead of
 * removing the document. It now does a real deleteOne, matching the hard-delete
 * pattern already used by doctorRoutes.js and referrerRoutes.js. All filtering
 * on `deletion.status` has been removed from every query in this file as a
 * result — it's dead weight once nothing sets that field anymore.
 *
 * IMPORTANT: if your `staffs` collection already has documents with
 * `deletion.status: true` from the old soft-delete system, those rows will
 * REAPPEAR in listings once this filter is gone, because they were never
 * actually removed from the collection. Run a one-time cleanup before
 * deploying this change:
 *   db.staffs.deleteMany({ "deletion.status": true })
 */

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
    summary: "Permanently delete a staff member",
    params: staffIdParamSchema,
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Derived from ALLOWED_PERMISSIONS so it never drifts out of sync
const normalizePermissions = (perms = {}) =>
  Object.fromEntries(ALLOWED_PERMISSIONS.map((p) => [p.key, perms[p.key] ?? false]));

// Cryptographically-random one-time password for new staff, sent via SMS and
// meant to be changed on first login. Previously this reused
// generateInvoiceId() — a business-ID generator, not a credential generator —
// which is very likely lower-entropy and more predictable than a password
// needs to be. base64url gives 64 symbols/char (~6 bits/char); 12 chars is
// ~72 bits of entropy, comfortably strong for a short-lived temp credential.
const generateTempPassword = (length = 12) => crypto.randomBytes(length).toString("base64url").slice(0, length);

// ─── Routes ───────────────────────────────────────────────────────────────────

async function staffRoutes(fastify) {
  const collection = fastify.mongo.db.collection(collectionName);
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("onRequest", fastify.requireAdmin);

  // ── Scoped duplicate checker ──────────────────────────────────────────────
  // Only ever called from POST /staff/add (never with an excludeId — email/
  // phone can't be edited post-registration, so there's no "check duplicate
  // excluding myself" case). Kept simple accordingly.
  const checkDuplicate = async (req, field, value) => {
    return collection.findOne({ [field]: value, labId: labId(req) }, { projection: { _id: 1 } });
  };

  // Shared guard used by every route that edits or changes the lifecycle state
  // of an existing staff record: staff must exist in this lab and must not be
  // an admin account (admins always have fixed, full access, and must never
  // be deactivated/deleted/reassigned via these routes — including by another
  // admin, and including targeting themselves).
  const findEditableStaff = async (req, reply) => {
    const _id = toObjectId(req.params.id);
    if (!_id) {
      reply.code(400).send({ error: "Invalid staff ID" });
      return null;
    }
    const existing = await collection.findOne({ _id, labId: labId(req) }, { projection: { role: 1 } });
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
          { labId: labId(req) },
          {
            projection: {
              name: 1,
              email: 1,
              phone: 1,
              permissions: 1,
              isActive: 1,
              role: 1,
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

      const password = generateTempPassword();
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
        { _id, labId: labId(req) },
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
  // FIXED: previously didn't invalidate tokens, unlike permissions/deactivate/
  // delete above and below. /refresh rebuilds the access token from the OLD
  // refresh token's own embedded claims rather than re-querying this
  // collection, so a staff member's live session kept using their stale
  // maxLabAdjustment indefinitely via silent refresh — an admin lowering the
  // limit had no real effect until the staff member's refresh token expired
  // naturally. Now forces re-login, matching every other sensitive change here.
  fastify.put("/staff/:id/adjustment", updateAdjustmentSchema, async (req, reply) => {
    try {
      const _id = await findEditableStaff(req, reply);
      if (!_id) return;

      await collection.updateOne(
        { _id, labId: labId(req) },
        {
          $set: {
            maxLabAdjustment: req.body.maxLabAdjustment,
            updated: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
          },
        },
      );

      await fastify.mongo.db.collection("tokens").deleteMany({ userId: _id });

      return { message: "Adjustment limit updated successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update adjustment limit" });
    }
  });

  // ── PATCH /staff/:id/deactivate ───────────────────────────────────────────
  fastify.patch("/staff/:id/deactivate", deactivateStaffSchema, async (req, reply) => {
    try {
      const _id = await findEditableStaff(req, reply);
      if (!_id) return;

      await collection.updateOne(
        { _id, labId: labId(req) },
        {
          $set: {
            isActive: false,
            updated: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
          },
        },
      );

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
      const _id = await findEditableStaff(req, reply);
      if (!_id) return;

      await collection.updateOne(
        { _id, labId: labId(req) },
        {
          $set: {
            isActive: true,
            updated: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
          },
        },
      );
      return { message: "Staff activated successfully", _id: req.params.id };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to activate staff member" });
    }
  });

  // ── DELETE /staff/:id ─────────────────────────────────────────────────────
  // Hard delete — was previously a soft delete (deletion.status flag). Now
  // matches the hard-delete pattern already used by doctorRoutes.js and
  // referrerRoutes.js. Still guarded by findEditableStaff (admin accounts
  // can never be targeted) and still invalidates any active sessions, same
  // as deactivate — a deleted staff member's existing refresh token must not
  // keep working.
  fastify.delete("/staff/:id", deleteStaffSchema, async (req, reply) => {
    try {
      const _id = await findEditableStaff(req, reply);
      if (!_id) return;

      const result = await collection.deleteOne({ _id, labId: labId(req) });
      if (result.deletedCount === 0) return reply.code(404).send({ error: "Staff not found" });

      await fastify.mongo.db.collection("tokens").deleteMany({ userId: _id });

      return { message: "Staff deleted successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to delete staff member" });
    }
  });
}

export default staffRoutes;
