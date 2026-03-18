import { ObjectId } from "mongodb";

const collectionName = "referrers";

const referrerBodySchema = {
  type: "object",
  required: ["name", "contactNumber", "type", "commissionType", "commissionValue"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    contactNumber: { type: "string", minLength: 1, maxLength: 15 },
    degree: { type: "string", maxLength: 200 },
    details: { type: "string", maxLength: 500 },
    type: { type: "string", enum: ["doctor", "agent", "institute"] },
    commissionType: { type: "string", enum: ["percentage", "fixed"] },
    commissionValue: { type: "number", minimum: 0 },
    isActive: { type: "boolean" },
  },
  additionalProperties: true,
};

const isValidObjectId = (id) => ObjectId.isValid(id) && String(new ObjectId(id)) === id;

async function routes(fastify, options) {
  const collection = fastify.mongo.db.collection(collectionName);

  fastify.get("/referrers", async (req, reply) => {
    return collection.find({}).sort({ name: 1 }).toArray();
  });

  fastify.get("/referrer/:id", async (req, reply) => {
    if (!isValidObjectId(req.params.id)) {
      return reply.code(400).send({ error: "Invalid referrer ID" });
    }
    const referrer = await collection.findOne({ _id: new ObjectId(req.params.id) });
    if (!referrer) return reply.code(404).send({ error: "Referrer not found" });
    return referrer;
  });

  fastify.post("/referrer/add", { schema: { body: referrerBodySchema } }, async (req, reply) => {
    const { formType, _id, ...data } = req.body;

    if (data.commissionType === "percentage" && data.commissionValue > 100) {
      return reply.code(400).send({ error: "Percentage must be between 0 and 100" });
    }

    const result = await collection.insertOne({ ...data, isActive: data.isActive ?? true });
    return reply.code(201).send({ _id: result.insertedId });
  });

  fastify.put(
    "/referrer/edit/:id",
    { schema: { body: { ...referrerBodySchema, required: [] } } },
    async (req, reply) => {
      if (!isValidObjectId(req.params.id)) {
        return reply.code(400).send({ error: "Invalid referrer ID" });
      }

      const { formType, _id, ...data } = req.body;

      if (data.commissionType === "percentage" && data.commissionValue > 100) {
        return reply.code(400).send({ error: "Percentage must be between 0 and 100" });
      }

      const result = await collection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: data });
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Referrer not found" });

      return { message: "Referrer updated successfully" };
    },
  );

  fastify.patch("/referrer/:id/deactivate", async (req, reply) => {
    if (!isValidObjectId(req.params.id)) {
      return reply.code(400).send({ error: "Invalid referrer ID" });
    }
    const result = await collection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { isActive: false } });
    if (result.matchedCount === 0) return reply.code(404).send({ error: "Referrer not found" });
    return { message: "Referrer deactivated successfully", _id: req.params.id };
  });

  fastify.patch("/referrer/:id/activate", async (req, reply) => {
    if (!isValidObjectId(req.params.id)) {
      return reply.code(400).send({ error: "Invalid referrer ID" });
    }
    const result = await collection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { isActive: true } });
    if (result.matchedCount === 0) return reply.code(404).send({ error: "Referrer not found" });
    return { message: "Referrer activated successfully", _id: req.params.id };
  });

  fastify.delete("/referrer/:id", async (req, reply) => {
    if (!isValidObjectId(req.params.id)) {
      return reply.code(400).send({ error: "Invalid referrer ID" });
    }
    const result = await collection.deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) return reply.code(404).send({ error: "Referrer not found" });
    return { message: "Referrer deleted successfully" };
  });
}

export default routes;
