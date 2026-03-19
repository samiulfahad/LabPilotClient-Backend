export async function ensureIndexes(db) {
  const invoices = db.collection("invoices");

  await invoices.createIndex(
    { labId: 1, createdAt: -1, isDeleted: 1 },
    { name: "idx_labId_createdAt_isDeleted", background: true },
  );
}
