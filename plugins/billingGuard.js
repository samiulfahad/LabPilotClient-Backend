// ── plugins/billingGuard.js  (client backend) ────────────────────────────────
//
// In-memory cache of billing status per lab.
// TTL: 5 minutes — avoids hammering MongoDB on every invoice creation / status check.
// Cache is invalidated immediately when a lab pays (or admin pays on their behalf).
//
// Usage in routes:
//   const blocked = await fastify.checkBillingBlocked(labIdObjectId);
//   if (blocked) return reply.code(402).send({ error: "Account overdue. Please pay your outstanding bill." });
//
//   const status = await fastify.getBillingStatus(labIdObjectId);
//   // { hasUnpaid: boolean, blocked: boolean, amount: number|null, dueDate: number|null }

import fp from "fastify-plugin";
import toObjectId from "../utils/db.js";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function billingGuardPlugin(fastify) {
  // Map<labIdString, { status: BillingStatus, expiresAt: number }>
  const cache = new Map();

  async function fetchBillingStatus(labId) {
    // A lab has an unpaid bill if any "unpaid" billing doc exists.
    // It's "blocked" (hard-gated) only once that bill's dueDate has passed.
    // We only need the most recent unpaid bill — if it's not overdue, none are.
    const unpaidBill = await fastify.mongo.db
      .collection("billings")
      .findOne(
        { labId, status: "unpaid" },
        { projection: { dueDate: 1, totalAmount: 1 }, sort: { billingPeriodStart: -1 } },
      );

    if (!unpaidBill) {
      return { hasUnpaid: false, blocked: false, amount: 0, dueDate: null };
    }

    const blocked = unpaidBill.dueDate != null && Date.now() > unpaidBill.dueDate; // pure UTC comparison — timezone-safe

    return {
      hasUnpaid: true,
      blocked,
      amount: unpaidBill.totalAmount ?? null,
      dueDate: unpaidBill.dueDate ?? null,
    };
  }

  /**
   * Returns the full billing status for a lab (unpaid flag, blocked flag, amount, dueDate).
   * Uses in-memory cache with 5-minute TTL.
   *
   * @param {import('mongodb').ObjectId} labIdObj
   * @returns {Promise<{hasUnpaid: boolean, blocked: boolean, amount: number|null, dueDate: number|null}>}
   */
  fastify.decorate("getBillingStatus", async (labIdObj) => {
    const key = labIdObj.toString();
    const cached = cache.get(key);

    if (cached && Date.now() < cached.expiresAt) return cached.status;

    const status = await fetchBillingStatus(labIdObj);
    cache.set(key, { status, expiresAt: Date.now() + CACHE_TTL_MS });
    return status;
  });

  /**
   * Returns true if the lab is blocked (overdue unpaid bill).
   * Backward-compatible wrapper — backed by the same cache as getBillingStatus,
   * so this does NOT trigger a second DB round trip if the status was just fetched.
   *
   * @param {import('mongodb').ObjectId} labIdObj
   * @returns {Promise<boolean>}
   */
  fastify.decorate("checkBillingBlocked", async (labIdObj) => {
    const status = await fastify.getBillingStatus(labIdObj);
    return status.blocked;
  });

  /**
   * Immediately removes a lab from the billing status cache.
   * Call this after a lab pays their bill (or an admin pays on their behalf).
   *
   * @param {import('mongodb').ObjectId} labIdObj
   */
  fastify.decorate("invalidateBillingCache", (labIdObj) => {
    cache.delete(labIdObj.toString());
  });

  // ── Piggyback billing status on every authenticated response ─────────────
  // Lets the frontend pick up a payment/status change on the very next API
  // call any staff session happens to make — no dedicated polling request,
  // no extra DB cost beyond the same 5-min cache every other check already
  // shares. This is what keeps OTHER logged-in sessions (not the one that
  // just paid) in sync without waiting out the poll interval.
  fastify.addHook("onSend", async (req, reply, payload) => {
    if (!req.user?.labId) return payload; // skip unauthenticated routes (login, etc.)
    try {
      const status = await fastify.getBillingStatus(toObjectId(req.user.labId));
      reply.header("X-Billing-Due", String(status.hasUnpaid));
      if (status.hasUnpaid) {
        reply.header("X-Billing-Overdue", String(status.blocked));
        reply.header("X-Billing-Due-Date", String(status.dueDate));
      }
    } catch (err) {
      req.log.warn({ err }, "[billingGuard] Failed to attach billing header");
    }
    return payload;
  });
}

export default fp(billingGuardPlugin);
