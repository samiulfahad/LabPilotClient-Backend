// ── plugins/billingGuard.js  (client backend) ────────────────────────────────
//
// In-memory cache of blocked status per lab.
// TTL: 5 minutes — avoids hammering MongoDB on every invoice creation.
// Cache is invalidated immediately when a lab pays (or admin pays on their behalf).
//
// Usage in routes:
//   const blocked = await fastify.checkBillingBlocked(labIdObjectId);
//   if (blocked) return reply.code(402).send({ error: "Account overdue. Please pay your outstanding bill." });

import fp from "fastify-plugin";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function billingGuardPlugin(fastify) {
  // Map<labIdString, { blocked: boolean, expiresAt: number }>
  const cache = new Map();

  async function fetchBlockedStatus(labId) {
    // A lab is blocked if it has ANY unpaid bill whose dueDate has passed.
    // We only need to check the most recent unpaid bill (if it's overdue, the lab is blocked).
    const unpaidBill = await fastify.mongo.db
      .collection("billings")
      .findOne({ labId, status: "unpaid" }, { projection: { dueDate: 1 }, sort: { billingPeriodStart: -1 } });

    if (!unpaidBill) return false; // No unpaid bill → not blocked
    if (unpaidBill.dueDate == null) return false; // Shouldn't happen for unpaid, but safe guard

    return Date.now() > unpaidBill.dueDate; // Pure UTC comparison — timezone-safe
  }

  /**
   * Returns true if the lab is blocked (overdue unpaid bill).
   * Uses in-memory cache with 5-minute TTL.
   *
   * @param {import('mongodb').ObjectId} labIdObj
   * @returns {Promise<boolean>}
   */
  fastify.decorate("checkBillingBlocked", async (labIdObj) => {
    const key = labIdObj.toString();
    const cached = cache.get(key);

    if (cached && Date.now() < cached.expiresAt) return cached.blocked;

    const blocked = await fetchBlockedStatus(labIdObj);
    cache.set(key, { blocked, expiresAt: Date.now() + CACHE_TTL_MS });
    return blocked;
  });

  /**
   * Immediately removes a lab from the blocked cache.
   * Call this after a lab pays their bill.
   *
   * @param {import('mongodb').ObjectId} labIdObj
   */
  fastify.decorate("invalidateBillingCache", (labIdObj) => {
    cache.delete(labIdObj.toString());
  });
}

export default fp(billingGuardPlugin);
