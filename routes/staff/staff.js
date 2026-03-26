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
  username: { type: "string", minLength: 3, maxLength: 30, description: "Unique username" },
  email: { type: "string", minLength: 5, maxLength: 254, description: "Unique email address" },
  mobileNumber: { type: "string", minLength: 10, maxLength: 15, description: "Unique mobile number" },
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
      required: ["name", "username", "email", "mobileNumber", "permissions"],
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
      properties: staffBodyProperties,
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
    summary: "Hard delete a staff member",
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
    const query = { [field]: value };
    if (excludeId) query._id = { $ne: toObjectId(excludeId) };
    return collection.findOne(query, { projection: { _id: 1 } });
  };

  // ── GET /staffs ───────────────────────────────────────────────────────────
  fastify.get("/staffs", getAllStaffSchema, async (req, reply) => {
    try {
      return collection
        .find(
          { labId: labId(req) },
          { projection: { name: 1, username: 1, email: 1, mobileNumber: 1, permissions: 1, isActive: 1 } },
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

      const staffMember = await collection.findOne({ _id, labId: labId(req) });
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
      const { type, _id, ...data } = req.body;

      const email = data.email.toLowerCase().trim();
      const username = data.username.toLowerCase().trim();
      const mobile = data.mobileNumber.trim();
      const name = data.name.trim();

      if (!EMAIL_REGEX.test(email)) {
        return reply.code(400).send({ error: "Invalid email format" });
      }
      if (await checkDuplicate("username", username)) {
        return reply.code(400).send({ error: "Username already exists" });
      }
      if (await checkDuplicate("email", email)) {
        return reply.code(400).send({ error: "Email already exists" });
      }
      if (await checkDuplicate("mobileNumber", mobile)) {
        return reply.code(400).send({ error: "Mobile number already exists" });
      }

      const result = await collection.insertOne({
        labId: labId(req),
        name,
        username,
        email,
        mobileNumber: mobile,
        permissions: normalizePermissions(data.permissions),
        isActive: data.isActive ?? true,
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

      const { id } = req.params;
      const { type, _id: bodyId, ...data } = req.body;

      const email = data.email?.toLowerCase().trim();
      const username = data.username?.toLowerCase().trim();
      const mobile = data.mobileNumber?.trim();
      const name = data.name?.trim();

      if (email) {
        if (!EMAIL_REGEX.test(email)) {
          return reply.code(400).send({ error: "Invalid email format" });
        }
        if (await checkDuplicate("email", email, id)) {
          return reply.code(400).send({ error: "Email already exists" });
        }
      }
      if (username && (await checkDuplicate("username", username, id))) {
        return reply.code(400).send({ error: "Username already exists" });
      }
      if (mobile && (await checkDuplicate("mobileNumber", mobile, id))) {
        return reply.code(400).send({ error: "Mobile number already exists" });
      }

      const updateData = {
        ...(name && { name }),
        ...(username && { username }),
        ...(email && { email }),
        ...(mobile && { mobileNumber: mobile }),
        ...(data.permissions && { permissions: normalizePermissions(data.permissions) }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        updated: { at: Date.now(), by: { id: req.user.id, name: req.user.name } },
      };

      const result = await collection.updateOne({ _id, labId: labId(req) }, { $set: updateData });
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
        { _id, labId: labId(req) },
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
        { _id, labId: labId(req) },
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

      const result = await collection.deleteOne({ _id, labId: labId(req) });
      if (result.deletedCount === 0) return reply.code(404).send({ error: "Staff not found" });
      return { message: "Staff deleted successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to delete staff member" });
    }
  });
}

export default staffRoutes;
