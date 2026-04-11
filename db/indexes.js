export async function ensureIndexes(db) {
  const invoices = db.collection("invoices");
  const tokens = db.collection("tokens");

  await Promise.all([
    // ── Invoices: TTL — auto-deletes invoices 6 months after creation ───────
    // expiresAt is set to new Date(Date.now() + 180 days) at insert time
    // createdAt is kept as a number timestamp and is unaffected
    invoices.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "idx_invoices_ttl" }),

    // ── Invoices: primary query index ────────────────────────────────────────
    // uses "deletion.status" — the actual field name in the document
    invoices.createIndex(
      { labId: 1, createdAt: -1, "deletion.status": 1 },
      { name: "idx_invoices_labId_createdAt_deletionStatus" },
    ),

    // ── Tokens: TTL — auto-deletes expired sessions every ~60s ──────────────
    tokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "idx_tokens_ttl" }),

    // ── Tokens: covers /refresh, /logout, and session count on /login ────────
    tokens.createIndex({ userId: 1, deviceId: 1, refreshToken: 1 }, { name: "idx_tokens_lookup" }),
  ]);
}
