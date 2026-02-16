import { ObjectId } from "mongodb";

const collectionName = "myTestList";

async function routes(fastify, options) {
  const collection = fastify.mongo.db.collection(collectionName);

  // Helper to convert _id to string
  const toClientFormat = (doc) => {
    if (!doc) return null;
    return { ...doc, _id: doc._id.toString() };
  };

  // GET required data for creating invoice
  fastify.get("/invoice/required-data", async (req, reply) => {
    try {
      const referrers = await fastify.mongo.db.collection("referrers").find({}).sort({ createdAt: -1 }).toArray();
      const tests = await fastify.mongo.db.collection("myTestList").find({}).sort({ createdAt: -1 }).toArray();
      return { referrers, tests };
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch tests" });
    }
  });
}

export default routes;
