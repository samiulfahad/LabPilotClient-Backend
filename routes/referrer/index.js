import { ObjectId } from "mongodb";

const collectionName = "referrers";

async function routes(fastify, options) {
  const collection = fastify.mongo.db.collection(collectionName);

  // Helper to convert _id to string
  const toClientFormat = (doc) => {
    if (!doc) return null;
    return { ...doc, _id: doc._id.toString() };
  };

  // GET all referrers
  fastify.get("/referrers", async (req, reply) => {
    const referrers = await collection.find({}).sort({ createdAt: -1 }).toArray();

    return referrers.map(toClientFormat);
  });

  // GET single referrer
  fastify.get("/referrer/:id", async (req, reply) => {
    const { id } = req.params;
    const referrer = await collection.findOne({ _id: new ObjectId(id) });

    if (!referrer) {
      reply.code(404).send({ error: "Referrer not found" });
      return;
    }

    return toClientFormat(referrer);
  });

  // POST - Create Referrer
  fastify.post("/referrer/add", async (req, reply) => {
    const { type, _id, ...data } = req.body; // remove frontend-only fields

    // Validation
    if (!data.name?.trim()) return reply.code(400).send({ error: "Name is required" });
    if (!data.contactNumber?.trim()) return reply.code(400).send({ error: "Contact number is required" });

    if (data.commissionType === "percentage") {
      if (data.commissionValue < 0 || data.commissionValue > 100) {
        return reply.code(400).send({ error: "Percentage must be between 0 and 100" });
      }
    }
    if (data.commissionValue < 0) {
      return reply.code(400).send({ error: "Commission value cannot be negative" });
    }

    const newReferrer = {
      ...data,
      isActive: data.isActive ?? true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await collection.insertOne(newReferrer);
    reply.code(201).send({ _id: result.insertedId });
  });

  // PUT - Update Referrer
  fastify.put("/referrer/edit/:id", async (req, reply) => {
    const { id } = req.params;
    const { type, _id, ...data } = req.body;

    const updateData = {
      ...data,
      updatedAt: new Date(),
    };

    const result = await collection.updateOne({ _id: new ObjectId(id) }, { $set: updateData });

    if (result.matchedCount === 0) {
      reply.code(404).send({ error: "Referrer not found" });
      return;
    }

    const updated = await collection.findOne({ _id: new ObjectId(id) });
    return toClientFormat(updated);
  });

  // PATCH - Deactivate Referrer
  fastify.patch("/referrer/:id/deactivate", async (req, reply) => {
    const { id } = req.params;

    const result = await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { isActive: false, updatedAt: new Date() } },
    );

    if (result.matchedCount === 0) {
      reply.code(404).send({ error: "Referrer not found" });
      return;
    }

    return { message: "Referrer deactivated successfully", _id: id };
  });


  // PATCH - Activate Referrer
  fastify.patch("/referrer/:id/activate", async (req, reply) => {
    const { id } = req.params;

    const result = await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { isActive: true, updatedAt: new Date() } },
    );

    if (result.matchedCount === 0) {
      reply.code(404).send({ error: "Referrer not found" });
      return;
    }

    return { message: "Referrer activated successfully", _id: id };
  });

  // DELETE - Hard Delete
  fastify.delete("/referrer/:id", async (req, reply) => {
    const { id } = req.params;

    const result = await collection.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      reply.code(404).send({ error: "Referrer not found" });
      return;
    }

    return { message: "Referrer deleted successfully" };
  });
}

export default routes;
