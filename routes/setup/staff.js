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
 *
 * MIGRATION NOTE — random temp password → password-set link (this change):
 * New staff no longer get a random password texted to them in plaintext.
 * Registration now leaves `password: null` and issues the same one-time,
 * hashed-token link used by the admin-creation flow in labRoutes.js. A new
 * resend endpoint lets an admin re-send that link — but only while the
 * staff member still hasn't set a password (`password: null`); once set,
 * resend is refused rather than silently minting a link that could hijack
 * a live account.
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
    summary: "Add a new staff member to the lab — sends a password-set link via SMS",
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

const resendPasswordSetupSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Resend the password-set SMS link — only while no password has been set yet",
    params: staffIdParamSchema,
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Derived from ALLOWED_PERMISSIONS so it never drifts out of sync
const normalizePermissions = (perms = {}) =>
  Object.fromEntries(ALLOWED_PERMISSIONS.map((p) => [p.key, perms[p.key] ?? false]));

// Derives the set of module names a staff member has ANY access to, from
// their normalized permissions map. A module stays out of the array unless
// at least one of its permission keys is true; as soon as the last enabled
// permission in a module is turned off, the module drops out on the next
// recompute. Always call this AFTER normalizePermissions so every key is
// present. Order follows ALLOWED_PERMISSIONS' first occurrence of each
// module, not insertion order of the permissions object.
const computeModules = (normalizedPerms) => {
  const modules = [];
  for (const p of ALLOWED_PERMISSIONS) {
    if (normalizedPerms[p.key] && !modules.includes(p.module)) {
      modules.push(p.module);
    }
  }
  return modules;
};

const hashToken = (raw) => crypto.createHash("sha256").update(raw).digest("hex");

// ─── Routes ───────────────────────────────────────────────────────────────────

async function staffRoutes(fastify) {
  const collection = fastify.mongo.db.collection(collectionName);
  const labsCollection = fastify.mongo.db.collection("labs");
  const passwordSetTokens = () => fastify.mongo.db.collection("passwordSetTokens");
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

  // Issues a fresh one-time password-set token for a staff member and texts
  // the link. Wipes any still-live token for that staff first, so an older
  // SMS (from initial creation or a previous resend) can't be used alongside
  // a newer one. Shared by POST /staff/add and POST /staff/:id/resend-password.
  // Returns whether the SMS actually went out — the token/DB side is already
  // committed either way, so a failed send here is a "resend it" situation,
  // not a lost account.
  const issuePasswordSetLink = async (fastify, { staffId, lid, labKey, name, phone }) => {
    await passwordSetTokens().deleteMany({ staffId });

    const rawToken = crypto.randomBytes(32).toString("hex");
    const now = new Date();

    await passwordSetTokens().insertOne({
      staffId,
      labId: lid,
      tokenHash: hashToken(rawToken),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000), // 24h
    });

    const setPasswordUrl = `${process.env.CLIENT_URL}/set-password?token=${rawToken}&labKey=${labKey}`;

    try {
      await fastify.sendSMS({
        number: phone,
        message: `LabPilotPro.com-এ আপনাকে স্বাগতম, ${name}। আপনার পাসওয়ার্ড সেট করুন: ${setPasswordUrl} (২৪ ঘণ্টার মধ্যে মেয়াদ শেষ হবে)`,
      });
      return true;
    } catch (err) {
      fastify.log.error({ err, staffId }, "Failed to send staff password-set SMS");
      return false;
    }
  };

  // ── GET /staffs ───────────────────────────────────────────────────────────
  fastify.get("/staffs", getAllStaffSchema, async (req, reply) => {
    try {
      const lid = labId(req);
      const [staffs, lab] = await Promise.all([
        collection
          .find(
            { labId: lid },
            {
              projection: {
                name: 1,
                email: 1,
                phone: 1,
                permissions: 1,
                modules: 1,
                isActive: 1,
                role: 1,
                maxLabAdjustment: 1,
                password: 1,
              },
            },
          )
          .sort({ name: 1 })
          .toArray(),
        labsCollection.findOne({ _id: lid }, { projection: { "limit.maxStaff": 1 } }),
      ]);

      // hasPasswordSet lets the frontend show/hide the "resend link" action
      // without exposing the hash itself.
      const withFlags = staffs.map(({ password, ...s }) => ({ ...s, hasPasswordSet: Boolean(password) }));

      return { staffs: withFlags, maxStaff: typeof lab?.limit?.maxStaff === "number" ? lab.limit.maxStaff : null };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch staff" });
    }
  });

  // ── POST /staff/add ───────────────────────────────────────────────────────
  fastify.post("/staff/add", createStaffSchema, async (req, reply) => {
    try {
      const lid = labId(req);

      // ── Staff seat-limit check ──────────────────────────────────────────
      // Each lab's plan caps the number of staff (role:"staff") accounts it
      // can register — admins are exempt, since they're a fixed account
      // type rather than a provisioned seat. This is the authoritative
      // check: the frontend also disables the "Add Staff" button proactively
      // once the limit is reached, but that's UX only — this is what
      // actually stops a direct API call from exceeding the plan's limit.
      const lab = await labsCollection.findOne({ _id: lid }, { projection: { "limit.maxStaff": 1 } });
      const maxStaff = lab?.limit?.maxStaff;

      if (typeof maxStaff === "number") {
        const currentStaffCount = await collection.countDocuments({ labId: lid, role: "staff" });
        if (currentStaffCount >= maxStaff) {
          return reply.code(403).send({
            error: `আপনার প্ল্যানে সর্বোচ্চ ${maxStaff} জন স্টাফ যোগ করা যাবে। সীমা বাড়াতে আপনার প্ল্যান আপগ্রেড করুন।`,
            code: "STAFF_LIMIT_REACHED",
            limit: maxStaff,
            current: currentStaffCount,
          });
        }
      }

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

      const normalizedPermissions = normalizePermissions(permissions);
      const name_ = name.trim();
      const labKeyStr = String(req.user.labKey);

      const result = await collection.insertOne({
        labId: lid,
        labKey: labKeyStr,
        name: name_,
        ...(email && { email }),
        phone,
        password: null, // set once the SMS link is used
        role: "staff",
        permissions: normalizedPermissions,
        modules: computeModules(normalizedPermissions),
        isActive: true,
        maxLabAdjustment: maxLabAdjustment ?? 0,
        created: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
      });

      const smsSent = await issuePasswordSetLink(fastify, {
        staffId: result.insertedId,
        lid,
        labKey: labKeyStr,
        name: name_,
        phone,
      });

      return reply.code(201).send({ _id: result.insertedId, smsSent });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to create staff member" });
    }
  });

  // ── POST /staff/:id/resend-password-setup ─────────────────────────────────
  // Only valid while the staff member hasn't set a password yet. Once
  // password is non-null, this is refused — resending after that point would
  // let anyone with admin access mint a fresh link to hijack an already-live
  // account rather than just help someone who never got/used the first SMS.
  fastify.post("/staff/:id/resend-password-setup", resendPasswordSetupSchema, async (req, reply) => {
    try {
      const lid = labId(req);
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid staff ID" });

      const staff = await collection.findOne(
        { _id, labId: lid },
        { projection: { role: 1, password: 1, phone: 1, name: 1, labKey: 1 } },
      );
      if (!staff) return reply.code(404).send({ error: "Staff not found" });
      if (staff.role === "admin") return reply.code(403).send({ error: "Admin accounts cannot be edited" });
      if (staff.password) return reply.code(409).send({ error: "This staff member has already set their password" });

      const smsSent = await issuePasswordSetLink(fastify, {
        staffId: _id,
        lid,
        labKey: staff.labKey,
        name: staff.name,
        phone: staff.phone,
      });

      return { message: smsSent ? "Password-set link resent" : "Link created but SMS failed to send", smsSent };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to resend password-set link" });
    }
  });

  // ── PUT /staff/:id/permissions ────────────────────────────────────────────
  fastify.put("/staff/:id/permissions", updatePermissionsSchema, async (req, reply) => {
    try {
      const _id = await findEditableStaff(req, reply);
      if (!_id) return;

      const normalizedPermissions = normalizePermissions(req.body.permissions);

      await collection.updateOne(
        { _id, labId: labId(req) },
        {
          $set: {
            permissions: normalizedPermissions,
            modules: computeModules(normalizedPermissions),
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
      await passwordSetTokens().deleteMany({ staffId: _id });

      return { message: "Staff deleted successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to delete staff member" });
    }
  });
}

export default staffRoutes;
