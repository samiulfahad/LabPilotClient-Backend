// ── plugins/billingGuard.js ───────────────────────────────────────────────────
//
// Fastify plugin: checks whether a lab is blocked due to an overdue unpaid bill.
// Results are cached for CACHE_TTL_MS to avoid hammering MongoDB on every request.
//
// A lab is blocked when:
//   - it has at least one bill with status "unpaid"
//   - AND the current UTC time is past that bill's dueDate

import fp from "fastify-plugin";

async function billingGuardPlugin(fastify) {
  const cache = new Map();
  const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  async function fetchBlockedStatus(labIdObj) {
    // Find the most-recent unpaid bill for this lab
    const unpaidBill = await fastify.mongo.db
      .collection("billings")
      .findOne({ labId: labIdObj, status: "unpaid" }, { projection: { dueDate: 1 }, sort: { billingPeriodStart: -1 } });

    if (!unpaidBill) return false;
    // dueDate is stored as UTC ms snapped to 23:59:59 BST
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
