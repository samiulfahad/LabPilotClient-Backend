// plugins/billingGuardPlugin.js
//
// Caches whether a lab is "billing-blocked" (has an overdue unpaid bill).
// Cache TTL is intentionally short (5 min) so the block lifts quickly after
// payment without needing a push-invalidation in every code path.
//
// "Blocked" means: the lab has at least one unpaid billing whose dueDate
// epoch-ms is in the past (dueDate < Date.now()).  dueDate is stored as
// 23:59:59.999 BST of the due calendar day — so the block kicks in
// automatically at midnight BST the day after the due date.
// ─────────────────────────────────────────────────────────────────────────────

import fp from "fastify-plugin";

async function billingGuardPlugin(fastify) {
  // labId (string) → { blocked: boolean, expiresAt: epoch-ms }
  const cache = new Map();
  const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  async function fetchBlockedStatus(labId) {
    // Find the most-recent unpaid bill for this lab.
    const unpaidBill = await fastify.mongo.db
      .collection("billings")
      .findOne({ labId, status: "unpaid" }, { projection: { dueDate: 1 }, sort: { billingPeriodStart: -1 } });

    if (!unpaidBill) return false;
    // dueDate is epoch-ms at 23:59:59.999 BST of the due day.
    // The lab is blocked once that moment has passed.
    return Date.now() > unpaidBill.dueDate;
  }

  fastify.decorate("checkBillingBlocked", async (labIdObj) => {
    const key = labIdObj.toString();
    const cached = cache.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached.blocked;

    const blocked = await fetchBlockedStatus(labIdObj);
    cache.set(key, { blocked, expiresAt: Date.now() + CACHE_TTL_MS });
    return blocked;
  });

  fastify.decorate("invalidateBillingCache", (labIdObj) => {
    cache.delete(labIdObj.toString());
  });
}

export default fp(billingGuardPlugin);
