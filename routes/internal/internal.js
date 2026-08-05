import toObjectId from "../../utils/db.js";

const cacheInvalidateSchema = {
  schema: {
    params: {
      type: "object",
      required: ["labId"],
      additionalProperties: false,
      properties: {
        labId: { type: "string", pattern: "^[a-fA-F0-9]{24}$" },
      },
    },
  },
};

async function internalRoutes(fastify) {
  fastify.post("/internal/billing/cache-invalidate/:labId", cacheInvalidateSchema, async (req, reply) => {
    try {
      const secret = req.headers["x-internal-secret"];
      if (!secret || secret !== process.env.INTERNAL_SECRET) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const labId = toObjectId(req.params.labId);
      if (!labId) return reply.code(400).send({ error: "Invalid labId" });

      fastify.invalidateBillingCache(labId);
      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Cache invalidation failed" });
    }
  });
}

export default internalRoutes;
