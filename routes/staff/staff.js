import toObjectId from "../../utils/db.js";

const collectionName = "staff";

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
  properties: {
    createInvoice: { type: "boolean" },
    editInvoice: { type: "boolean" },
    deleteInvoice: { type: "boolean" },
    cashmemo: { type: "boolean" },
    uploadReport: { type: "boolean" },
    downloadReport: { type: "boolean" },
  },
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
  isActive: { type: "boolean", description: "Whether the staff member is active (defaults to true)" },
};

// ─── Route Schemas ────────────────────────────────────────────────────────────

const getAllStaffSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Get all staff for the lab",
  },
};

const getStaffByIdSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Get a single staff member by ID",
    params: staffIdParamSchema,
  },
};

const createStaffSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Add a new staff member to the lab",
    body: {
      type: "object",
      required: ["name", "phone", "permissions"], // email is optional
      additionalProperties: false,
      properties: staffBodyProperties,
    },
  },
};

const updateStaffSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Update an existing staff member",
    params: staffIdParamSchema,
    body: {
      type: "object",
      required: [],
      additionalProperties: false,
      minProperties: 1,
      description: "At least one field must be provided",
      properties: {
        name: staffBodyProperties.name,
        email: staffBodyProperties.email,
        permissions: staffBodyProperties.permissions,
        isActive: staffBodyProperties.isActive,
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

const normalizePermissions = (perms = {}) => ({
  createInvoice: perms.createInvoice ?? false,
  editInvoice: perms.editInvoice ?? false,
  deleteInvoice: perms.deleteInvoice ?? false,
  cashmemo: perms.cashmemo ?? false,
  uploadReport: perms.uploadReport ?? false,
  downloadReport: perms.downloadReport ?? false,
});

// ─── Routes ───────────────────────────────────────────────────────────────────

async function staffRoutes(fastify, options) {
  const collection = fastify.mongo.db.collection(collectionName);
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);

  const checkDuplicate = async (field, value, excludeId = null) => {
    const query = { [field]: value, "deletion.status": { $ne: true } };
    if (excludeId) query._id = { $ne: toObjectId(excludeId) };
    return collection.findOne(query, { projection: { _id: 1 } });
  };

  // ── GET /staffs ───────────────────────────────────────────────────────────
  fastify.get("/staffs", getAllStaffSchema, async (req, reply) => {
    try {
      return collection
        .find(
          { labId: labId(req), "deletion.status": { $ne: true } },
          { projection: { name: 1, email: 1, phone: 1, permissions: 1, isActive: 1, deletion: 1 } },
        )
        .sort({ name: 1 })
        .toArray();
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch staff" });
    }
  });

  // ── GET /staff/:id ────────────────────────────────────────────────────────
  fastify.get("/staff/:id", getStaffByIdSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid staff ID" });

      const staffMember = await collection.findOne({
        _id,
        labId: labId(req),
        "deletion.status": { $ne: true },
      });
      if (!staffMember) return reply.code(404).send({ error: "Staff not found" });
      return staffMember;
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch staff member" });
    }
  });

  // ── POST /staff/add ───────────────────────────────────────────────────────
  fastify.post("/staff/add", createStaffSchema, async (req, reply) => {
    try {
      const { name, email: rawEmail, phone: rawPhone, permissions, isActive } = req.body;

      const email = rawEmail?.trim() ? rawEmail.toLowerCase().trim() : null;
      const phone = rawPhone.trim();

      if (email) {
        if (!EMAIL_REGEX.test(email)) {
          return reply.code(400).send({ error: "Invalid email format" });
        }
        if (await checkDuplicate("email", email)) {
          return reply.code(400).send({ error: "Email already exists" });
        }
      }
      if (await checkDuplicate("phone", phone)) {
        return reply.code(400).send({ error: "Phone number already exists" });
      }

      const result = await collection.insertOne({
        labId: labId(req),
        name: name.trim(),
        ...(email && { email }),
        phone,
        permissions: normalizePermissions(permissions),
        isActive: isActive ?? true,
        deletion: { status: false, at: null, by: null },
        created: { at: Date.now(), by: { id: req.user.id, name: req.user.name } },
      });

      return reply.code(201).send({ _id: result.insertedId });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to create staff member" });
    }
  });

  // ── PUT /staff/edit/:id ───────────────────────────────────────────────────
  fastify.put("/staff/edit/:id", updateStaffSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid staff ID" });

      const { name, email: rawEmail, permissions, isActive } = req.body;

      const email = rawEmail?.trim() ? rawEmail.toLowerCase().trim() : null;

      if (email) {
        if (!EMAIL_REGEX.test(email)) {
          return reply.code(400).send({ error: "Invalid email format" });
        }
        if (await checkDuplicate("email", email, req.params.id)) {
          return reply.code(400).send({ error: "Email already exists" });
        }
      }

      const updateData = {
        ...(name && { name: name.trim() }),
        ...(email && { email }),
        ...(permissions && { permissions: normalizePermissions(permissions) }),
        ...(isActive !== undefined && { isActive }),
        updated: { at: Date.now(), by: { id: req.user.id, name: req.user.name } },
      };

      const result = await collection.updateOne(
        { _id, labId: labId(req), "deletion.status": { $ne: true } },
        { $set: updateData },
      );
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Staff not found" });

      return { message: "Staff updated successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update staff member" });
    }
  });

  // ── PATCH /staff/:id/deactivate ───────────────────────────────────────────
  fastify.patch("/staff/:id/deactivate", deactivateStaffSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid staff ID" });

      const result = await collection.updateOne(
        { _id, labId: labId(req), "deletion.status": { $ne: true } },
        { $set: { isActive: false, updated: { at: Date.now(), by: { id: req.user.id, name: req.user.name } } } },
      );
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Staff not found" });
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
        { $set: { isActive: true, updated: { at: Date.now(), by: { id: req.user.id, name: req.user.name } } } },
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
              by: { id: req.user.id, name: req.user.name },
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
