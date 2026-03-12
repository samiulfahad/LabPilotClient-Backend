// routes/commission.routes.js

async function routes(fastify, options) {
  // ============================================================================
  // Index: reuses idx_labId_createdAt_isDeleted already created by
  // cashmemo.routes.js. MongoDB can use that index for commission queries
  // too — the trailing isDeleted field doesn't block prefix usage on
  // (labId, createdAt). No new index needed here.
  // ============================================================================

  // ============================================================================
  // GET /commission/summary
  //
  // Query params:
  //   startDate  {number}  Unix ms (required)
  //   endDate    {number}  Unix ms (required)
  //
  // Response:
  // {
  //   registered:   [{ referrerId, name, type, degree, totalCommission,
  //                    totalInvoices, totalAmount, totalFinalPrice,
  //                    invoices: [{ invoiceId, patientName, createdAt,
  //                                 finalPrice, commission }] }],
  //   unregistered: [{ referredBy, totalCommission, totalInvoices,
  //                    totalAmount, invoices: [...] }],
  //   totals:       { totalCommission, totalInvoices }
  // }
  // ============================================================================
  fastify.get("/commission/summary", async (req, reply) => {
    try {
      const startDate = parseInt(req.query.startDate);
      const endDate = parseInt(req.query.endDate);

      // TODO: replace with dynamic labId from auth context
      const labId = 123456;

      if (!startDate || !endDate || isNaN(startDate) || isNaN(endDate)) {
        return reply.code(400).send({
          error: "startDate and endDate are required Unix ms timestamps",
        });
      }
      if (startDate > endDate) {
        return reply.code(400).send({ error: "startDate must be before endDate" });
      }

      const invoicesCol = fastify.mongo.db.collection("invoices");

      // ── Pipeline ────────────────────────────────────────────────────────────
      //
      // referredBy is a mixed-type field:
      //   • 24-char hex string  → registered referrer ObjectId
      //   • "Self" / plain name → unregistered
      //
      // We use $regexMatch to detect ObjectIds, convert to ObjectId for $lookup,
      // then group by referrer with per-invoice detail array.
      // ────────────────────────────────────────────────────────────────────────
      const pipeline = [
        // ── 1. Index-backed match ─────────────────────────────────────────────
        {
          $match: {
            labId,
            createdAt: { $gte: startDate, $lte: endDate },
            isDeleted: { $ne: true },
          },
        },

        // ── 2. Detect whether referredBy is a valid ObjectId string ───────────
        {
          $addFields: {
            _isRegistered: {
              $regexMatch: {
                input: { $toString: "$referredBy" },
                regex: "^[a-f0-9]{24}$",
              },
            },
          },
        },

        // ── 3. Convert to ObjectId for registered; null for unregistered ──────
        {
          $addFields: {
            _referrerOid: {
              $cond: {
                if: "$_isRegistered",
                then: { $toObjectId: "$referredBy" },
                else: null,
              },
            },
          },
        },

        // ── 4. Left-join referrers collection ─────────────────────────────────
        //    Returns [] for unregistered (null localField → no match)
        {
          $lookup: {
            from: "referrers",
            localField: "_referrerOid",
            foreignField: "_id",
            as: "_referrerDoc",
          },
        },

        // ── 5. Flatten looked-up referrer ─────────────────────────────────────
        {
          $addFields: {
            _ref: { $arrayElemAt: ["$_referrerDoc", 0] },
          },
        },

        // ── 6. Shape fields for grouping ──────────────────────────────────────
        {
          $project: {
            invoiceId: 1,
            patientName: 1,
            createdAt: 1,
            finalPrice: 1,
            totalAmount: 1,
            referrerCommission: 1,
            referrerDiscount: 1,
            referredBy: 1,
            _isRegistered: 1,
            _referrerId: { $ifNull: [{ $toString: "$_ref._id" }, null] },
            _referrerName: { $ifNull: ["$_ref.name", null] },
            _referrerType: { $ifNull: ["$_ref.type", null] },
            _referrerDegree: { $ifNull: ["$_ref.degree", null] },
            // Group key: ObjectId string for registered, raw value for others
            _groupKey: {
              $cond: {
                if: "$_isRegistered",
                then: { $toString: "$_ref._id" },
                else: { $toString: "$referredBy" },
              },
            },
          },
        },

        // ── 7. Group by referrer ──────────────────────────────────────────────
        {
          $group: {
            _id: "$_groupKey",
            isRegistered: { $first: "$_isRegistered" },
            referrerId: { $first: "$_referrerId" },
            name: { $first: "$_referrerName" },
            type: { $first: "$_referrerType" },
            degree: { $first: "$_referrerDegree" },
            rawReferredBy: { $first: "$referredBy" },
            totalCommission: { $sum: { $ifNull: ["$referrerCommission", 0] } },
            totalDiscount: { $sum: { $ifNull: ["$referrerDiscount", 0] } },
            totalInvoices: { $sum: 1 },
            totalAmount: { $sum: { $ifNull: ["$totalAmount", 0] } },
            totalFinalPrice: { $sum: { $ifNull: ["$finalPrice", 0] } },
            invoices: {
              $push: {
                invoiceId: "$invoiceId",
                patientName: "$patientName",
                createdAt: "$createdAt",
                finalPrice: "$finalPrice",
                commission: { $ifNull: ["$referrerCommission", 0] },
                discount: { $ifNull: ["$referrerDiscount", 0] },
              },
            },
          },
        },

        // ── 8. Sort: highest commission first ─────────────────────────────────
        { $sort: { totalCommission: -1, totalInvoices: -1 } },
      ];

      const rows = await invoicesCol
        .aggregate(pipeline, { hint: "idx_labId_createdAt_isDeleted", allowDiskUse: true })
        .toArray();

      // ── Split into registered / unregistered ─────────────────────────────
      const registered = [];
      const unregistered = [];

      for (const row of rows) {
        if (row.isRegistered && row.referrerId) {
          registered.push({
            referrerId: row.referrerId,
            name: row.name ?? "Unknown",
            type: row.type ?? "unknown",
            degree: row.degree ?? "",
            totalCommission: row.totalCommission,
            totalDiscount: row.totalDiscount,
            totalInvoices: row.totalInvoices,
            totalAmount: row.totalAmount,
            totalFinalPrice: row.totalFinalPrice,
            invoices: row.invoices,
          });
        } else {
          unregistered.push({
            referredBy: row.rawReferredBy ?? row._id,
            totalCommission: row.totalCommission,
            totalDiscount: row.totalDiscount,
            totalInvoices: row.totalInvoices,
            totalAmount: row.totalAmount,
            invoices: row.invoices,
          });
        }
      }

      const totalCommission = rows.reduce((s, r) => s + r.totalCommission, 0);
      const totalDiscount = rows.reduce((s, r) => s + (r.totalDiscount ?? 0), 0);
      const totalInvoices = rows.reduce((s, r) => s + r.totalInvoices, 0);

      return reply.send({ registered, unregistered, totals: { totalCommission, totalDiscount, totalInvoices } });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch commission summary" });
    }
  });
}

export default routes;
