import { ObjectId } from "mongodb";

const collectionName = "staff";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const staffBodySchema = {
  type: "object",
  required: ["name", "username", "email", "mobileNumber", "permissions"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    username: { type: "string", minLength: 3, maxLength: 30 },
    email: { type: "string", minLength: 5, maxLength: 254 },
    mobileNumber: { type: "string", minLength: 10, maxLength: 15 },
    permissions: {
      type: "object",
      properties: {
        createInvoice: { type: "boolean" },
        editInvoice: { type: "boolean" },
        deleteInvoice: { type: "boolean" },
        cashmemo: { type: "boolean" },
        uploadReport: { type: "boolean" },
        downloadReport: { type: "boolean" },
      },
      additionalProperties: false,
    },
    isActive: { type: "boolean" },
  },
  additionalProperties: true,
};

const isValidObjectId = (id) => ObjectId.isValid(id) && String(new ObjectId(id)) === id;

const normalizePermissions = (perms = {}) => ({
  createInvoice: perms.createInvoice ?? false,
  editInvoice: perms.editInvoice ?? false,
  deleteInvoice: perms.deleteInvoice ?? false,
  cashmemo: perms.cashmemo ?? false,
  uploadReport: perms.uploadReport ?? false,
  downloadReport: perms.downloadReport ?? false,
});

async function routes(fastify, options) {
  const collection = fastify.mongo.db.collection(collectionName);

  const checkDuplicate = async (field, value, excludeId = null) => {
    const query = { [field]: value };
    if (excludeId) query._id = { $ne: new ObjectId(excludeId) };
    return collection.findOne(query, { projection: { _id: 1 } });
  };

  // GET all staff
  fastify.get("/staffs", async (req, reply) => {
    return collection
      .find({}, { projection: { name: 1, username: 1, email: 1, mobileNumber: 1, permissions: 1, isActive: 1 } })
      .sort({ name: 1 })
      .toArray();
  });

  // GET single staff
  fastify.get("/staff/:id", async (req, reply) => {
    if (!isValidObjectId(req.params.id)) {
      return reply.code(400).send({ error: "Invalid staff ID" });
    }
    const staffMember = await collection.findOne({ _id: new ObjectId(req.params.id) });
    if (!staffMember) return reply.code(404).send({ error: "Staff not found" });
    return staffMember;
  });

  // POST - Create Staff
  fastify.post("/staff/add", { schema: { body: staffBodySchema } }, async (req, reply) => {
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
      name,
      username,
      email,
      mobileNumber: mobile,
      permissions: normalizePermissions(data.permissions),
      isActive: data.isActive ?? true,
    });

    return reply.code(201).send({ _id: result.insertedId });
  });

  // PUT - Update Staff
  fastify.put("/staff/edit/:id", { schema: { body: { ...staffBodySchema, required: [] } } }, async (req, reply) => {
    if (!isValidObjectId(req.params.id)) {
      return reply.code(400).send({ error: "Invalid staff ID" });
    }

    const { id } = req.params;
    const { type, _id, ...data } = req.body;

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
    };

    const result = await collection.updateOne({ _id: new ObjectId(id) }, { $set: updateData });
    if (result.matchedCount === 0) return reply.code(404).send({ error: "Staff not found" });

    return { message: "Staff updated successfully" };
  });

  // PATCH - Deactivate
  fastify.patch("/staff/:id/deactivate", async (req, reply) => {
    if (!isValidObjectId(req.params.id)) {
      return reply.code(400).send({ error: "Invalid staff ID" });
    }
    const result = await collection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { isActive: false } });
    if (result.matchedCount === 0) return reply.code(404).send({ error: "Staff not found" });
    return { message: "Staff deactivated successfully", _id: req.params.id };
  });

  // PATCH - Activate
  fastify.patch("/staff/:id/activate", async (req, reply) => {
    if (!isValidObjectId(req.params.id)) {
      return reply.code(400).send({ error: "Invalid staff ID" });
    }
    const result = await collection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { isActive: true } });
    if (result.matchedCount === 0) return reply.code(404).send({ error: "Staff not found" });
    return { message: "Staff activated successfully", _id: req.params.id };
  });

  // DELETE
  fastify.delete("/staff/:id", async (req, reply) => {
    if (!isValidObjectId(req.params.id)) {
      return reply.code(400).send({ error: "Invalid staff ID" });
    }
    const result = await collection.deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) return reply.code(404).send({ error: "Staff not found" });
    return { message: "Staff deleted successfully" };
  });
}

export default routes;
