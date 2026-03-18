// commission.routes.js

const summaryQuerySchema = {
  schema: {
    querystring: {
      type: "object",
      required: ["startDate", "endDate"],
      properties: {
        startDate: { type: "integer" },
        endDate: { type: "integer" },
      },
    },
  },
};

async function routes(fastify) {
  // Compound index: labId (equality) → createdAt (range) → isDeleted (filter)
  try {
    await fastify.mongo.db
      .collection("invoices")
      .createIndex(
        { labId: 1, createdAt: -1, isDeleted: 1 },
        { name: "idx_labId_createdAt_isDeleted", background: true },
      );

    // For referrer drill-down endpoint (future)
    await fastify.mongo.db
      .collection("invoices")
      .createIndex(
        { labId: 1, "referrer.id": 1, createdAt: -1 },
        { name: "idx_labId_referrerId_createdAt", background: true },
      );
  } catch (err) {
    fastify.log.warn({ err }, "commission: could not ensure indexes");
  }

  // ── GET /commission/summary ───────────────────────────────────────────────
  // Query params: startDate {number} Unix ms, endDate {number} Unix ms
  fastify.get("/commission/summary", summaryQuerySchema, async (req, reply) => {
    const { startDate, endDate } = req.query;

    if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

    // TODO: replace with req.user.labId from auth context once multi-tenancy is wired up
    const labId = 123456;

    try {
      const rows = await fastify.mongo.db
        .collection("invoices")
        .aggregate(
          [
            // ── Stage 1: index-backed match ──────────────────────────────────
            // Uses full compound index: labId (eq) → createdAt (range) → isDeleted (eq)
            // isDeleted: false is stored explicitly on all documents,
            // so this is index-friendly unlike $ne: true
            {
              $match: {
                labId,
                createdAt: { $gte: startDate, $lte: endDate },
                isDeleted: false,
                "referrer.name": { $exists: true, $type: "string" },
              },
            },

            // ── Stage 2: group by referrer ───────────────────────────────────
            // Key: referrer.id for registered referrers, referrer.name for walk-ins
            // $first is safe — referrer name/type is stable per referrer.id
            // No pre-sort needed (dropped the expensive O(n log n) sort)
            {
              $group: {
                _id: { $ifNull: ["$referrer.id", "$referrer.name"] },
                name: { $first: "$referrer.name" },
                type: { $first: "$referrer.type" },
                referrerId: { $first: "$referrer.id" },
                totalCommission: { $sum: { $ifNull: ["$amount.referrerCommission", 0] } },
                totalDiscount: { $sum: { $ifNull: ["$amount.referrerDiscount", 0] } },
                totalFinal: { $sum: { $ifNull: ["$amount.final", 0] } },
                totalNet: { $sum: { $ifNull: ["$amount.net", 0] } },
                totalInvoices: { $sum: 1 },
                // Capped at 100 via $slice in next stage.
                // For full list use: GET /commission/invoices?referrerId=&startDate=&endDate=
                invoices: {
                  $push: {
                    invoiceId: "$invoiceId",
                    patientName: "$patient.name",
                    createdAt: "$createdAt",
                    final: { $ifNull: ["$amount.final", 0] },
                    net: { $ifNull: ["$amount.net", 0] },
                    commission: { $ifNull: ["$amount.referrerCommission", 0] },
                    discount: { $ifNull: ["$amount.referrerDiscount", 0] },
                  },
                },
              },
            },

            // ── Stage 3: derive fields + cap invoices array ──────────────────
            // $gt: [value, null] → true for any non-null/non-missing value
            {
              $addFields: {
                isRegistered: { $gt: ["$referrerId", null] },
                invoices: { $slice: ["$invoices", 100] },
              },
            },

            // ── Stage 4: highest commission first ────────────────────────────
            { $sort: { totalCommission: -1, totalInvoices: -1 } },
          ],
          { hint: "idx_labId_createdAt_isDeleted", allowDiskUse: true },
        )
        .toArray();

      // ── Single-pass split + totals ────────────────────────────────────────
      const registered = [];
      const unregistered = [];
      let totalCommission = 0;
      let totalDiscount = 0;
      let totalFinal = 0;
      let totalNet = 0;
      let totalInvoices = 0;

      for (const row of rows) {
        totalCommission += row.totalCommission;
        totalDiscount += row.totalDiscount;
        totalFinal += row.totalFinal;
        totalNet += row.totalNet;
        totalInvoices += row.totalInvoices;

        const base = {
          totalCommission: row.totalCommission,
          totalDiscount: row.totalDiscount,
          totalFinal: row.totalFinal,
          totalNet: row.totalNet,
          totalInvoices: row.totalInvoices,
          invoices: row.invoices,
        };

        if (row.isRegistered) {
          registered.push({
            referrerId: row.referrerId,
            name: row.name ?? "Unknown",
            type: row.type ?? "unknown",
            ...base,
          });
        } else {
          unregistered.push({
            referredBy: row.name ?? row._id,
            ...base,
          });
        }
      }

      return reply.send({
        registered,
        unregistered,
        totals: {
          totalCommission,
          totalDiscount,
          totalFinal,
          totalNet,
          totalInvoices,
        },
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch commission summary" });
    }
  });
}

export default routes;
