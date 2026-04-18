export async function generateMonthlyBills(db, options = {}) {
  const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
  const DUE_DAYS = parseInt(process.env.BILLING_DUE_DAYS) || 7;
  const nowUtc = Date.now();

  let y, m;
  if (options.year && options.month) {
    y = options.year;
    m = options.month; // 1-indexed
  } else {
    const nowDhaka = new Date(nowUtc + DHAKA_OFFSET_MS);
    y = nowDhaka.getUTCFullYear();
    m = nowDhaka.getUTCMonth() + 1; // 1-indexed
  }

  const periodStart = new Date(Date.UTC(y, m - 1, 1)); // e.g. 2026-03-01T00:00:00.000Z
  const periodEnd = new Date(Date.UTC(y, m, 1)); // e.g. 2026-04-01T00:00:00.000Z — query bound only
  const periodEndDisplay = new Date(Date.UTC(y, m, 0)); // e.g. 2026-03-31T00:00:00.000Z — stored for display
  const dueDate = periodEnd.getTime() + DUE_DAYS * 24 * 60 * 60 * 1000;
  const triggeredBy = options.triggeredBy || "cron";

  const labs = await db
    .collection("labs")
    .find({ }, { projection: { _id: 1, name: 1, billing: 1 } })
    .toArray();

  let generated = 0;
  let free = 0;
  let skipped = 0;
  const failedLabs = [];

  for (const lab of labs) {
    try {
      // ── Idempotency check — one bill per lab per period ────────────────
      const exists = await db
        .collection("billings")
        .findOne({ labId: lab._id, billingPeriodStart: periodStart }, { projection: { _id: 1 } });
      if (exists) {
        skipped++;
        continue;
      }

      const monthlyFee = lab.billing?.monthlyFee ?? 0;
      const perInvoiceFee = lab.billing?.perInvoiceFee ?? 0;
      const commission = lab.billing?.commission ?? 0;

      const invoiceCount = await db.collection("invoices").countDocuments({
        labId: lab._id,
        "deletion.status": false,
        createdAt: {
          $gte: periodStart.getTime(),
          $lt: periodEnd.getTime(),
        },
      });

      const perInvoiceNet = perInvoiceFee - commission;
      const totalAmount = monthlyFee + perInvoiceNet * invoiceCount;
      const isFree = totalAmount <= 0;

      await db.collection("billings").insertOne({
        labId: lab._id,
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEndDisplay,
        invoiceCount,
        breakdown: {
          monthlyFee,
          perInvoiceFee,
          commission,
          perInvoiceNet,
        },
        totalAmount: isFree ? 0 : totalAmount,
        status: isFree ? "free" : "unpaid",
        dueDate: isFree ? null : dueDate,
        createdAt: nowUtc,
        paidAt: null,
        paidBy: null,
      });

      isFree ? free++ : generated++;
    } catch (err) {
      failedLabs.push({
        labId: lab._id,
        labName: lab.name ?? "Unknown",
        error: err.message,
      });
    }
  }

  const runDoc = {
    period: periodStart.toISOString().slice(0, 7),
    periodStart,
    triggeredBy,
    triggeredAt: nowUtc,
    totalLabs: labs.length,
    generated,
    free,
    skipped,
    failedCount: failedLabs.length,
    failedLabs,
    hasErrors: failedLabs.length > 0,
  };

  await db.collection("billingRuns").insertOne(runDoc);

  console.log(
    "[billing]",
    JSON.stringify({
      period: runDoc.period,
      generated,
      free,
      skipped,
      failedCount: failedLabs.length,
    }),
  );

  return runDoc;
}

export async function retryFailedLabs(db, run) {
  const DUE_DAYS = parseInt(process.env.BILLING_DUE_DAYS) || 7;

  const periodStart = run.periodStart;
  const periodEnd = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1));
  const periodEndDisplay = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 0));
  const dueDate = periodEnd.getTime() + DUE_DAYS * 24 * 60 * 60 * 1000;
  const nowUtc = Date.now();

  const retried = [];
  const stillFailing = [];

  for (const failed of run.failedLabs) {
    try {
      const exists = await db
        .collection("billings")
        .findOne({ labId: failed.labId, billingPeriodStart: periodStart }, { projection: { _id: 1 } });
      if (exists) {
        retried.push({ labId: failed.labId, result: "already existed" });
        continue;
      }

      const lab = await db
        .collection("labs")
        .findOne({ _id: failed.labId }, { projection: { _id: 1, name: 1, billing: 1 } });

      if (!lab) {
        stillFailing.push({ labId: failed.labId, error: "Lab not found" });
        continue;
      }

      const monthlyFee = lab.billing?.monthlyFee ?? 0;
      const perInvoiceFee = lab.billing?.perInvoiceFee ?? 0;
      const commission = lab.billing?.commission ?? 0;

      const invoiceCount = await db.collection("invoices").countDocuments({
        labId: lab._id,
        "deletion.status": false,
        createdAt: {
          $gte: periodStart.getTime(),
          $lt: periodEnd.getTime(),
        },
      });

      const perInvoiceNet = perInvoiceFee - commission;
      const totalAmount = monthlyFee + perInvoiceNet * invoiceCount;
      const isFree = totalAmount <= 0;

      await db.collection("billings").insertOne({
        labId: lab._id,
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEndDisplay,
        invoiceCount,
        breakdown: { monthlyFee, perInvoiceFee, commission, perInvoiceNet },
        totalAmount: isFree ? 0 : totalAmount,
        status: isFree ? "free" : "unpaid",
        dueDate: isFree ? null : dueDate,
        createdAt: nowUtc,
        paidAt: null,
        paidBy: null,
      });

      retried.push({ labId: failed.labId, labName: lab.name, result: "success" });
    } catch (err) {
      stillFailing.push({
        labId: failed.labId,
        labName: failed.labName,
        error: err.message,
      });
    }
  }

  await db.collection("billingRuns").updateOne(
    { _id: run._id },
    {
      $set: {
        failedLabs: stillFailing,
        failedCount: stillFailing.length,
        hasErrors: stillFailing.length > 0,
        lastRetryAt: nowUtc,
        retryResult: { retried, stillFailing },
      },
    },
  );

  console.log(
    "[billing-retry]",
    JSON.stringify({
      period: run.period,
      retried: retried.length,
      stillFailing: stillFailing.length,
    }),
  );

  return { retried, stillFailing };
}
