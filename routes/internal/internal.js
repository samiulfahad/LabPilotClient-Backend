function internalRoutes(fastify) {
  fastify.post("/internal/billing/cache-invalidate/:labId", async (req, reply) => {
    try {
      const secret = req.headers["x-internal-secret"];
      if (!secret || secret !== process.env.INTERNAL_SECRET) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      fastify.invalidateBillingCache(toObjectId(req.params.labId));
      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Cache invalidation failed" });
    }
  });
}

export default internalRoutes;
