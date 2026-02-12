import { ObjectId } from "mongodb";

const collectionName = "staff";

async function routes(fastify, options) {
  const collection = fastify.mongo.db.collection(collectionName);

  // Helper to convert _id to string
  const toClientFormat = (doc) => {
    if (!doc) return null;
    return { ...doc, _id: doc._id.toString() };
  };

  // GET all staff
  fastify.get("/staffs", async (req, reply) => {
    const staff = await collection.find({}).sort({ createdAt: -1 }).toArray();

    return staff.map(toClientFormat);
  });

  // GET single staff member
  fastify.get("/staff/:id", async (req, reply) => {
    const { id } = req.params;
    const staffMember = await collection.findOne({ _id: new ObjectId(id) });

    if (!staffMember) {
      reply.code(404).send({ error: "Staff not found" });
      return;
    }

    return toClientFormat(staffMember);
  });

  // POST - Create Staff
  fastify.post("/staff/add", async (req, reply) => {
    const { type, _id, ...data } = req.body; // remove frontend-only fields

    // Validation
    if (!data.name?.trim()) {
      return reply.code(400).send({ error: "Name is required" });
    }
    if (!data.username?.trim()) {
      return reply.code(400).send({ error: "Username is required" });
    }
    if (!data.mobileNumber?.trim()) {
      return reply.code(400).send({ error: "Mobile number is required" });
    }

    // Check if username already exists
    const existingUser = await collection.findOne({ username: data.username.toLowerCase() });
    if (existingUser) {
      return reply.code(400).send({ error: "Username already exists" });
    }

    // Ensure permissions object exists with all fields
    const permissions = {
      createInvoice: data.permissions?.createInvoice ?? false,
      editInvoice: data.permissions?.editInvoice ?? false,
      deleteInvoice: data.permissions?.deleteInvoice ?? false,
      cashmemo: data.permissions?.cashmemo ?? false,
      uploadReport: data.permissions?.uploadReport ?? false,
    };

    const newStaff = {
      name: data.name.trim(),
      username: data.username.toLowerCase().trim(),
      mobileNumber: data.mobileNumber.trim(),
      permissions,
      isActive: data.isActive ?? true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await collection.insertOne(newStaff);
    reply.code(201).send({ _id: result.insertedId });
  });

  // PUT - Update Staff
  fastify.put("/staff/edit/:id", async (req, reply) => {
    const { id } = req.params;
    const { type, _id, ...data } = req.body;

    // Validation
    if (data.username) {
      // Check if username is taken by another staff member
      const existingUser = await collection.findOne({
        username: data.username.toLowerCase(),
        _id: { $ne: new ObjectId(id) },
      });
      if (existingUser) {
        return reply.code(400).send({ error: "Username already exists" });
      }
    }

    // Ensure permissions object exists with all fields
    const permissions = {
      createInvoice: data.permissions?.createInvoice ?? false,
      editInvoice: data.permissions?.editInvoice ?? false,
      deleteInvoice: data.permissions?.deleteInvoice ?? false,
      cashmemo: data.permissions?.cashmemo ?? false,
      uploadReport: data.permissions?.uploadReport ?? false,
    };

    const updateData = {
      name: data.name?.trim(),
      username: data.username?.toLowerCase().trim(),
      mobileNumber: data.mobileNumber?.trim(),
      permissions,
      isActive: data.isActive,
      updatedAt: new Date(),
    };

    // Remove undefined values
    Object.keys(updateData).forEach((key) => {
      if (updateData[key] === undefined) {
        delete updateData[key];
      }
    });

    const result = await collection.updateOne({ _id: new ObjectId(id) }, { $set: updateData });

    if (result.matchedCount === 0) {
      reply.code(404).send({ error: "Staff not found" });
      return;
    }

    const updated = await collection.findOne({ _id: new ObjectId(id) });
    return toClientFormat(updated);
  });

  // PATCH - Deactivate Staff
  fastify.patch("/staff/:id/deactivate", async (req, reply) => {
    const { id } = req.params;

    const result = await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { isActive: false, updatedAt: new Date() } },
    );

    if (result.matchedCount === 0) {
      reply.code(404).send({ error: "Staff not found" });
      return;
    }

    return { message: "Staff deactivated successfully", _id: id };
  });

  // PATCH - Activate Staff
  fastify.patch("/staff/:id/activate", async (req, reply) => {
    const { id } = req.params;

    const result = await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { isActive: true, updatedAt: new Date() } },
    );

    if (result.matchedCount === 0) {
      reply.code(404).send({ error: "Staff not found" });
      return;
    }

    return { message: "Staff activated successfully", _id: id };
  });

  // PATCH - Update Specific Permission
  fastify.patch("/staff/:id/permissions", async (req, reply) => {
    const { id } = req.params;
    const { permission, value } = req.body;

    const validPermissions = ["createInvoice", "editInvoice", "deleteInvoice", "cashmemo", "uploadReport"];

    if (!validPermissions.includes(permission)) {
      return reply.code(400).send({ error: "Invalid permission type" });
    }

    if (typeof value !== "boolean") {
      return reply.code(400).send({ error: "Permission value must be boolean" });
    }

    const result = await collection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          [`permissions.${permission}`]: value,
          updatedAt: new Date(),
        },
      },
    );

    if (result.matchedCount === 0) {
      reply.code(404).send({ error: "Staff not found" });
      return;
    }

    const updated = await collection.findOne({ _id: new ObjectId(id) });
    return toClientFormat(updated);
  });

  // DELETE - Hard Delete
  fastify.delete("/staff/:id", async (req, reply) => {
    const { id } = req.params;

    const result = await collection.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      reply.code(404).send({ error: "Staff not found" });
      return;
    }

    return { message: "Staff deleted successfully" };
  });

  // GET - Get staff by username (useful for login/authentication)
  fastify.get("/staff/username/:username", async (req, reply) => {
    const { username } = req.params;
    const staffMember = await collection.findOne({ username: username.toLowerCase() });

    if (!staffMember) {
      reply.code(404).send({ error: "Staff not found" });
      return;
    }

    return toClientFormat(staffMember);
  });

  // GET - Get active staff only
  fastify.get("/staff/active/list", async (req, reply) => {
    const activeStaff = await collection.find({ isActive: true }).sort({ name: 1 }).toArray();

    return activeStaff.map(toClientFormat);
  });

  // GET - Get staff with specific permission
  fastify.get("/staff/permission/:permission", async (req, reply) => {
    const { permission } = req.params;

    const validPermissions = ["createInvoice", "editInvoice", "deleteInvoice", "cashmemo", "uploadReport"];

    if (!validPermissions.includes(permission)) {
      return reply.code(400).send({ error: "Invalid permission type" });
    }

    const staff = await collection
      .find({ [`permissions.${permission}`]: true, isActive: true })
      .sort({ name: 1 })
      .toArray();

    return staff.map(toClientFormat);
  });
}

export default routes;
