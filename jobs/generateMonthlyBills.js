export async function generateMonthlyBills(db) {
  const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
  const DUE_DAYS = parseInt(process.env.BILLING_DUE_DAYS) || 7;

  const nowUtc = Date.now();
  const nowDhaka = new Date(nowUtc + DHAKA_OFFSET_MS);
  const y = nowDhaka.getUTCFullYear();
  const m = nowDhaka.getUTCMonth();

  const periodStart = new Date(Date.UTC(y, m - 1, 1) - DHAKA_OFFSET_MS);
  const periodEnd = new Date(Date.UTC(y, m, 1) - DHAKA_OFFSET_MS);
  const dueDate = new Date(Date.UTC(y, m, 1) - DHAKA_OFFSET_MS + DUE_DAYS * 24 * 60 * 60 * 1000).getTime();

  const labs = await db
    .collection("labs")
    .find({ isActive: true }, { projection: { _id: 1, billing: 1 } })
    .toArray();

  let generated = 0;
  let free = 0;
  let skipped = 0;

  for (const lab of labs) {
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
      billingPeriodEnd: periodEnd,
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
  }

  console.log(
    `[billing] ${periodStart.toISOString().slice(0, 7)} — generated: ${generated}, free: ${free}, skipped: ${skipped}`,
  );
}
