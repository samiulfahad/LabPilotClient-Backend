// utils/ipdBilling.js
// Single source of truth for IPD billing math — used by both the
// indoorPatients discount route and the cashmemo IPD reporting routes.

// Convert a UTC ms timestamp to its Bangladesh-local (UTC+6) calendar date string.
const toBstDateStr = (ts) => new Date(ts + 6 * 3600 * 1000).toISOString().slice(0, 10);

// Day-by-day bed charge for a "regular" deal patient, accounting for ward
// transfers. `uptoTs` defaults to now (open stay); pass releasedAt for a
// closed one. Package-deal patients have no bed charge — it's folded into
// packageDeal.totalAmount.
export function computeBedChargeTotal(admission, uptoTs = Date.now()) {
  if (admission.dealType !== "regular") return 0;

  const startStr = toBstDateStr(admission.admittedAt);
  const endStr = toBstDateStr(admission.releasedAt ?? uptoTs);
  const startD = new Date(startStr + "T00:00:00Z");
  const endD = new Date(endStr + "T00:00:00Z");

  let total = 0;
  const cur = new Date(startD);
  while (cur <= endD) {
    const d = cur.toISOString().slice(0, 10);
    let daily = admission.space.chargePerDay;
    for (const h of admission.wardHistory ?? []) {
      if (!h.fromDate || !h.toDate) continue;
      const from = toBstDateStr(h.fromDate);
      const to = toBstDateStr(h.toDate);
      if (d >= from && d < to) {
        daily = h.chargePerDay ?? admission.space.chargePerDay;
        break;
      }
    }
    total += daily;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return total;
}

export function computeExpenseTotal(expenses = []) {
  return expenses.reduce((s, e) => s + (e.total ?? e.price * e.quantity), 0);
}

export function computeTotalDiscounts(discounts = []) {
  return discounts.reduce((s, d) => s + d.amount, 0);
}

export function computeTotalPayments(payments = []) {
  return payments.reduce((s, p) => s + p.amount, 0);
}

// Grand total billed for an admission — package price for package deals,
// itemized expenses + bed charge for regular deals.
export function computeTotalBilled(admission, uptoTs = Date.now()) {
  if (admission.dealType === "package") return admission.packageDeal?.totalAmount ?? 0;
  return computeExpenseTotal(admission.expenses) + computeBedChargeTotal(admission, uptoTs);
}
