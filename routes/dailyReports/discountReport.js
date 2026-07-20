import toObjectId from "../../utils/db.js";

const summaryQuerySchema = {
  schema: {
    tags: ["Discount Report"],
    summary: "Get discount totals grouped by staff for a date range, split by source (OPD/IPD)",
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

async function discountReportRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("invoices");
  const indoorCol = () => fastify.mongo.db.collection("indoorPatients");
  const labId = (req) => toObjectId(req.user.labId);

  // Excludes soft-deleted indoor patients from every IPD discount figure.
  // Missing `deletion` field (pre-soft-delete legacy docs) still matches null.
  const notDeletedFilter = (req) => ({ labId: labId(req), "deletion.at": null });

  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("onRequest", fastify.authorize("discountReport"));

  fastify.get("/discount-report/summary", summaryQuerySchema, async (req, reply) => {
    const startDate = parseInt(req.query.startDate);
    const endDate = parseInt(req.query.endDate);

    if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

    const isHospital = req.user.type === "hospital"; // diagnosticCenter labs have no IPD data

    try {
      // ── Discount stats per staff (OPD invoices) ──────────────────────────
      // referrerDiscount is fixed at invoice creation time, so the staff
      // attributed here is whoever created the invoice (createdBy).
      const discountStatsPipeline = [
        {
          $match: {
            labId: labId(req),
            "deletion.status": false,
            createdAt: { $gte: startDate, $lte: endDate },
            "amount.referrerDiscount": { $gt: 0 },
          },
        },
        {
          $group: {
            _id: "$createdBy.id",
            staffName: { $last: "$createdBy.name" },
            totalDiscount: { $sum: "$amount.referrerDiscount" },
            invoices: {
              $push: {
                invoiceId: "$invoiceId",
                patient: "$patient.name",
                amount: "$amount.referrerDiscount",
                at: "$createdAt",
                source: "opd",
              },
            },
          },
        },
        {
          $addFields: {
            invoices: { $slice: ["$invoices", 200] },
          },
        },
      ];

      // ── Discount stats per staff (IPD discounts) ─────────────────────────
      // Indoor patients keep discounts in a flat `discounts[]` array (one
      // entry per applied discount, possibly several per patient), so we
      // look 90 days back to catch admissions started earlier, then filter
      // the discounts themselves to the requested window. Diagnostic
      // centers have no IPD module at all, so skip this query entirely for
      // them rather than hitting an irrelevant collection. Soft-deleted
      // admissions are excluded via notDeletedFilter so their discounts
      // never contribute to a staff member's totals.
      const indoorDiscountStatsPipeline = [
        {
          $match: {
            ...notDeletedFilter(req),
            admittedAt: { $gte: startDate - 90 * 24 * 60 * 60 * 1000, $lte: endDate },
          },
        },
        { $unwind: "$discounts" },
        {
          $match: {
            "discounts.appliedAt": { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: "$discounts.appliedBy.id",
            staffName: { $last: "$discounts.appliedBy.name" },
            totalDiscount: { $sum: "$discounts.amount" },
            patients: {
              $push: {
                admissionId: "$admissionId",
                patient: "$patient.name",
                category: "$discounts.category",
                providedBy: "$discounts.providedBy",
                amount: "$discounts.amount",
                at: "$discounts.appliedAt",
                source: "ipd",
              },
            },
          },
        },
        {
          $addFields: {
            patients: { $slice: ["$patients", 200] },
          },
        },
      ];

      const [opdDiscountRows, ipdDiscountRows] = await Promise.all([
        col().aggregate(discountStatsPipeline, { allowDiskUse: true }).toArray(),
        isHospital ? indoorCol().aggregate(indoorDiscountStatsPipeline, { allowDiskUse: true }).toArray() : [],
      ]);

      // ── Merge OPD + IPD rows by staff id, keeping source split ───────────
      const discountMap = new Map();
      for (const row of opdDiscountRows) {
        discountMap.set(String(row._id), {
          staffName: row.staffName,
          opdDiscount: row.totalDiscount,
          ipdDiscount: 0,
          invoices: [...row.invoices],
          patients: [],
        });
      }
      for (const row of ipdDiscountRows) {
        const key = String(row._id);
        const existing = discountMap.get(key);
        if (existing) {
          existing.ipdDiscount += row.totalDiscount;
          existing.patients.push(...row.patients);
          existing.staffName = existing.staffName ?? row.staffName;
        } else {
          discountMap.set(key, {
            staffName: row.staffName,
            opdDiscount: 0,
            ipdDiscount: row.totalDiscount,
            invoices: [],
            patients: [...row.patients],
          });
        }
      }

      const staff = [];
      for (const [staffId, row] of discountMap) {
        row.invoices.sort((a, b) => a.at - b.at);
        row.patients.sort((a, b) => a.at - b.at);
        staff.push({
          staffId,
          name: row.staffName ?? "Unknown",
          totalDiscount: row.opdDiscount + row.ipdDiscount,
          opdDiscount: row.opdDiscount,
          ipdDiscount: row.ipdDiscount,
          invoices: row.invoices.slice(0, 200),
          patients: row.patients.slice(0, 200),
        });
      }
      staff.sort((a, b) => b.totalDiscount - a.totalDiscount);

      // ── Grand totals ──────────────────────────────────────────────────────
      const totals = staff.reduce(
        (acc, s) => ({
          totalDiscount: acc.totalDiscount + s.totalDiscount,
          opdDiscount: acc.opdDiscount + s.opdDiscount,
          ipdDiscount: acc.ipdDiscount + s.ipdDiscount,
        }),
        { totalDiscount: 0, opdDiscount: 0, ipdDiscount: 0 },
      );

      return reply.send({ staff, totals });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch discount report" });
    }
  });
}

export default discountReportRoutes;
