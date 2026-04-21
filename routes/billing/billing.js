// ── routes/billing/billing.js  (client backend) ──────────────────────────────

import toObjectId from "../../utils/db.js";

async function billingRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("billings");

  fastify.addHook("onRequest", fastify.authenticate);

  // ── GET /billing/status ───────────────────────────────────────────────────
  // Returns the latest unpaid bill for the authenticated lab.
  fastify.get(
    "/billing/status",
    {
      schema: {
        tags: ["Billing"],
        summary: "Get current unpaid bill status for the authenticated lab",
      },
    },
    async (req, reply) => {
      try {
        const unpaidBill = await col().findOne(
          { labId: toObjectId(req.user.labId), status: "unpaid" },
          { sort: { billingPeriodStart: -1 } },
        );

        if (!unpaidBill) return reply.send({ hasUnpaidBill: false });

        const isOverdue = Date.now() > unpaidBill.dueDate;

        return reply.send({
          hasUnpaidBill: true,
          isOverdue,
          bill: {
            id: unpaidBill._id,
            amount: unpaidBill.totalAmount,
            dueDate: unpaidBill.dueDate,
            billingPeriodStart: unpaidBill.billingPeriodStart,
            billingPeriodEnd: unpaidBill.billingPeriodEnd,
            invoiceCount: unpaidBill.invoiceCount,
            breakdown: unpaidBill.breakdown,
          },
        });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch billing status" });
      }
    },
  );

  // ── GET /billing/history ──────────────────────────────────────────────────
  // Returns up to 24 months of billing history for the authenticated lab.
  fastify.get(
    "/billing/history",
    {
      schema: {
        tags: ["Billing"],
        summary: "Get billing history for the authenticated lab (last 24 months)",
      },
    },
    async (req, reply) => {
      try {
        const bills = await col()
          .find(
            { labId: toObjectId(req.user.labId) },
            {
              projection: {
                status: 1,
                totalAmount: 1,
                dueDate: 1,
                billingPeriodStart: 1,
                billingPeriodEnd: 1,
                invoiceCount: 1,
                breakdown: 1,
                paidAt: 1,
                paidBy: 1,
              },
            },
          )
          .sort({ billingPeriodStart: -1 })
          .limit(24)
          .toArray();

        return reply.send({ bills });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch billing history" });
      }
    },
  );

  // ── POST /billing/pay/:billingId ──────────────────────────────────────────
  // Labs pay their own bills. Replace the body with a payment gateway webhook later.
  fastify.post(
    "/billing/pay/:billingId",
    {
      schema: {
        tags: ["Billing"],
        summary: "Mark a bill as paid (payment gateway integration point)",
        params: {
          type: "object",
          required: ["billingId"],
          properties: {
            billingId: { type: "string", minLength: 24, maxLength: 24 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const labId = toObjectId(req.user.labId);

        const result = await col().updateOne(
          { _id: toObjectId(req.params.billingId), labId, status: "unpaid" },
          {
            $set: {
              status: "paid",
              paidAt: Date.now(),
              paidBy: { id: toObjectId(req.user.id), name: req.user.name },
            },
          },
        );

        if (result.matchedCount === 0) {
          return reply.code(404).send({ error: "Bill not found or already paid" });
        }

        // Unblock the lab immediately — invalidate the in-memory billing guard cache
        fastify.invalidateBillingCache(labId);

        return reply.send({ success: true });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to mark bill as paid" });
      }
    },
  );
}

export default billingRoutes;
