import fp from "fastify-plugin";

async function billingGuardPlugin(fastify) {
  const cache = new Map();
  const CACHE_TTL_MS = 5 * 60 * 1000;

  async function fetchBlockedStatus(labId) {
    const unpaidBill = await fastify.mongo.db
      .collection("billings")
      .findOne({ labId, status: "unpaid" }, { projection: { dueDate: 1 }, sort: { billingPeriodStart: -1 } });

    if (!unpaidBill) return false;
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
