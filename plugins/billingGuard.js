import fp from "fastify-plugin";
import { getCached, setCached, invalidate } from "../shared/billingCache.js";

async function billingGuardPlugin(fastify) {
  async function fetchBlockedStatus(labId) {
    const unpaidBill = await fastify.mongo.db
      .collection("billings")
      .findOne({ labId, status: "unpaid" }, { projection: { dueDate: 1 }, sort: { billingPeriodStart: -1 } });

    if (!unpaidBill) return false;
    return Date.now() > unpaidBill.dueDate;
  }

  fastify.decorate("checkBillingBlocked", async (labIdObj) => {
    const cached = getCached(labIdObj);
    if (cached !== null) return cached;

    const blocked = await fetchBlockedStatus(labIdObj);
    setCached(labIdObj, blocked);
    return blocked;
  });

  fastify.decorate("invalidateBillingCache", (labIdObj) => {
    invalidate(labIdObj);
  });
}

export default fp(billingGuardPlugin);
