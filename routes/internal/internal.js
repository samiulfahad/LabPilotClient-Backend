// ── routes/internal/internal.js  (client backend) ────────────────────────────
//
// Internal-only routes called by the admin backend.
// NOT behind fastify.authenticate — protected by INTERNAL_SECRET header only.
// Keep these routes off public API docs (no swagger tags).

import toObjectId from "../../utils/db.js";

async function internalRoutes(fastify) {
  // ── POST /internal/billing/cache-invalidate/:labId ────────────────────────
  // Called by admin backend immediately after marking a bill as paid,
  // so the lab can create invoices again without waiting for the 5-min TTL.
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
