import fp from "fastify-plugin";

// ─── Billing Guard Plugin ─────────────────────────────────────────────────────
//
// Decorates fastify with:
//   fastify.checkBillingBlocked(labIdObj) → Promise<boolean>
//   fastify.invalidateBillingCache(labIdObj)
//
// A lab is "blocked" when it has an unpaid bill whose dueDate has passed.
// dueDate is stored as a UTC epoch ms = 23:59:59.999 BST of the due calendar day.
// Comparison is simply Date.now() > dueDate — no timezone conversion needed here.
//
// Cache TTL: 5 minutes. The cache is invalidated immediately when a bill is paid
// (via fastify.invalidateBillingCache or the internal HTTP endpoint).

async function billingGuardPlugin(fastify) {
  const cache = new Map();
  const CACHE_TTL_MS = 5 * 60 * 1000;

  async function fetchBlockedStatus(labId) {
    // Get the most recent unpaid bill for this lab.
    // BUG FIX: the original code used findOne with a sort option in the projection
    // object, which is not supported by the Node MongoDB driver. Use find().sort().limit(1).next() instead.
    const unpaidBill = await fastify.mongo.db
      .collection("billings")
      .find({ labId, status: "unpaid" }, { projection: { dueDate: 1 } })
      .sort({ billingPeriodStart: -1 })
      .limit(1)
      .next();

    if (!unpaidBill) return false;

    // dueDate is UTC ms = end of due day 23:59:59.999 BST.
    // If now > dueDate the grace period has expired → blocked.
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
