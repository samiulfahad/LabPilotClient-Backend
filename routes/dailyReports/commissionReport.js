import toObjectId from "../../utils/db.js";

const summaryQuerySchema = {
  schema: {
    tags: ["Commission Report"],
    summary: "Get commission report for a date range",
    querystring: {
      type: "object",
      required: ["startDate", "endDate"],
      properties: {
        startDate: { type: "integer", description: "Start date as Unix timestamp (ms)" },
        endDate: { type: "integer", description: "End date as Unix timestamp (ms)" },
      },
    },
  },
};

async function commissionReportRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("invoices");
  const indoorCol = () => fastify.mongo.db.collection("indoorPatients");
  const labId = (req) => toObjectId(req.user.labId);
  const isHospital = (req) => req.user.type === "hospital"; // diagnosticCenter labs have no IPD module

  const notDeletedFilter = (req) => ({ labId: labId(req), "deletion.at": null });

  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("onRequest", fastify.authorize("commissionReport"));

  // ── GET /commission/summary ───────────────────────────────────────────────
  fastify.get("/commission-report/summary", summaryQuerySchema, async (req, reply) => {
    const startDate = parseInt(req.query.startDate);
    const endDate = parseInt(req.query.endDate);

    if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

    try {
      // ── Outdoor: commission + per-test commission (embedded on each invoice's test line — no external rate lookup needed) ──
      const outdoorRowsPromise = col()
        .aggregate(
          [
            {
              $match: {
                labId: labId(req),
                createdAt: { $gte: startDate, $lte: endDate },
                "deletion.status": false,
                "referrer.name": { $exists: true, $type: "string" },
              },
            },
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
                invoices: {
                  $push: {
                    invoiceId: "$invoiceId",
                    patientName: "$patient.name",
                    createdAt: "$createdAt",
                    final: { $ifNull: ["$amount.final", 0] },
                    net: { $ifNull: ["$amount.net", 0] },
                    commission: { $ifNull: ["$amount.referrerCommission", 0] },
                    discount: { $ifNull: ["$amount.referrerDiscount", 0] },
                    // Each test line already carries the commission rate that
                    // applied at the time of this invoice.
                    tests: {
                      $map: {
                        input: { $ifNull: ["$tests", []] },
                        as: "t",
                        in: { name: "$$t.name", commission: { $ifNull: ["$$t.commission", 0] } },
                      },
                    },
                  },
                },
              },
            },
            {
              $addFields: {
                isRegistered: { $gt: ["$referrerId", null] },
                invoices: { $slice: ["$invoices", 100] },
              },
            },
            { $sort: { totalCommission: -1, totalInvoices: -1 } },
          ],
          { allowDiskUse: true },
        )
        .toArray();

      // ── Indoor: test occurrences per doctor, grouped by (test, commission rate) ──
      // Grouping on rate — not just test — is what lets the frontend detect
      // and surface a mid-window commission change (e.g. CBC ৳200 → ৳150).
      // diagnosticCenter labs have no IPD module — skip entirely.
      const indoorRowsPromise = isHospital(req)
        ? indoorCol()
            .aggregate(
              [
                { $match: notDeletedFilter(req) },
                {
                  $project: {
                    _id: 0,
                    referrer: 1,
                    expenses: {
                      $filter: {
                        input: { $ifNull: ["$expenses", []] },
                        as: "e",
                        cond: {
                          $and: [
                            { $eq: ["$$e.type", "test"] },
                            { $gte: ["$$e.addedAt", startDate] },
                            { $lte: ["$$e.addedAt", endDate] },
                          ],
                        },
                      },
                    },
                  },
                },
                { $match: { "expenses.0": { $exists: true } } },
                { $unwind: "$expenses" },
                {
                  $group: {
                    _id: {
                      refKey: { $ifNull: ["$referrer.referrerId", "$referrer.name"] },
                      testKey: { $ifNull: ["$expenses.itemId", "$expenses.name"] },
                      rate: { $ifNull: ["$expenses.commission", 0] },
                    },
                    refName: { $first: "$referrer.name" },
                    refType: { $first: "$referrer.type" },
                    refId: { $first: "$referrer.referrerId" },
                    testName: { $first: "$expenses.name" },
                    count: { $sum: { $ifNull: ["$expenses.quantity", 1] } },
                    commissionTotal: {
                      $sum: {
                        $multiply: [{ $ifNull: ["$expenses.quantity", 1] }, { $ifNull: ["$expenses.commission", 0] }],
                      },
                    },
                    firstSeenAt: { $min: "$expenses.addedAt" },
                    lastSeenAt: { $max: "$expenses.addedAt" },
                  },
                },
              ],
              { allowDiskUse: true },
            )
            .toArray()
        : Promise.resolve([]);

      const [outdoorRows, indoorRows] = await Promise.all([outdoorRowsPromise, indoorRowsPromise]);

      // ── Fold indoor rows into a per-referrer map ──
      // tests: flat list of { name, rate, count, commissionTotal, firstSeenAt, lastSeenAt }
      // — one entry per (test, rate) combo — frontend merges same-name entries.
      const indoorByReferrer = new Map();
      for (const r of indoorRows) {
        if (!r.refName) continue;
        const key = String(r._id.refKey);
        if (!indoorByReferrer.has(key)) {
          indoorByReferrer.set(key, {
            name: r.refName,
            type: r.refType ?? "unknown",
            isRegistered: Boolean(r.refId),
            tests: [],
            totalTests: 0,
          });
        }
        const entry = indoorByReferrer.get(key);
        entry.tests.push({
          name: r.testName,
          rate: r._id.rate,
          count: r.count,
          commissionTotal: r.commissionTotal,
          firstSeenAt: r.firstSeenAt,
          lastSeenAt: r.lastSeenAt,
        });
        entry.totalTests += r.count;
      }

      // ── Build registered / unregistered lists from outdoor rows, attach indoor tests ──
      const registered = [];
      const unregistered = [];
      let totalCommission = 0,
        totalDiscount = 0,
        totalFinal = 0,
        totalNet = 0,
        totalInvoices = 0;

      for (const row of outdoorRows) {
        totalCommission += row.totalCommission;
        totalDiscount += row.totalDiscount;
        totalFinal += row.totalFinal;
        totalNet += row.totalNet;
        totalInvoices += row.totalInvoices;

        const key = String(row._id);
        const indoorEntry = indoorByReferrer.get(key);
        indoorByReferrer.delete(key);

        const base = {
          totalCommission: row.totalCommission,
          totalDiscount: row.totalDiscount,
          totalFinal: row.totalFinal,
          totalNet: row.totalNet,
          totalInvoices: row.totalInvoices,
          invoices: row.invoices,
          indoorTests: indoorEntry?.tests ?? [],
          totalIndoorTests: indoorEntry?.totalTests ?? 0,
        };

        if (row.isRegistered) {
          registered.push({
            referrerId: row.referrerId,
            name: row.name ?? "Unknown",
            type: row.type ?? "unknown",
            ...base,
          });
        } else {
          unregistered.push({ referredBy: row.name ?? row._id, ...base });
        }
      }

      // ── Doctors who only have indoor test activity (no outdoor invoices this window) ──
      for (const [key, entry] of indoorByReferrer) {
        const base = {
          totalCommission: 0,
          totalDiscount: 0,
          totalFinal: 0,
          totalNet: 0,
          totalInvoices: 0,
          invoices: [],
          indoorTests: entry.tests,
          totalIndoorTests: entry.totalTests,
        };
        if (entry.isRegistered) {
          registered.push({ referrerId: key, name: entry.name, type: entry.type, ...base });
        } else {
          unregistered.push({ referredBy: entry.name, ...base });
        }
      }

      return reply.send({
        registered,
        unregistered,
        totals: { totalCommission, totalDiscount, totalFinal, totalNet, totalInvoices },
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch commission summary" });
    }
  });
}

export default commissionReportRoutes;
