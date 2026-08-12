import bcrypt from "bcryptjs";
import crypto from "node:crypto";

const tokenField = { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" };

const verifyTokenBody = {
  type: "object",
  required: ["token"],
  additionalProperties: false,
  properties: { token: tokenField },
};

const setPasswordBody = {
  type: "object",
  required: ["token", "password"],
  additionalProperties: false,
  properties: {
    token: tokenField,
    password: { type: "string", minLength: 6, maxLength: 72 },
  },
};

const verifySchema = { tags: ["Auth"], summary: "Check a password-set token is valid", body: verifyTokenBody };
const setPasswordSchema = { tags: ["Auth"], summary: "Set password using a one-time token", body: setPasswordBody };

const hashToken = (raw) => crypto.createHash("sha256").update(raw).digest("hex");

export default async function setPasswordRoutes(fastify) {
  const staffs = () => fastify.mongo.db.collection("staffs");
  const passwordSetTokens = () => fastify.mongo.db.collection("passwordSetTokens");

  // Shared lookup: validates hash match, expiry, and that the staff record
  // is still live. Sends the error itself and returns null on any failure
  // so callers can just `if (!resolved) return;`.
  async function resolveToken(rawToken, reply) {
    const tokenDoc = await passwordSetTokens().findOne({ tokenHash: hashToken(rawToken) });

    // Doc is gone if it was never issued, already used (deleted on success),
    // or reaped by the TTL index after expiry.
    if (!tokenDoc) return (reply.code(400).send({ message: "Invalid or expired or used link" }), null);
    if (tokenDoc.expiresAt < new Date()) {
      return (reply.code(400).send({ message: "This link has expired. Ask an admin to resend it" }), null);
    }

    const staff = await staffs().findOne({ _id: tokenDoc.staffId, "deletion.status": { $ne: true } });
    if (!staff) return (reply.code(404).send({ message: "Account not found" }), null);

    return { tokenDoc, staff };
  }

  // POST /set-password/verify
  // Confirms the link is live and returns who it belongs to, without
  // consuming it — lets the frontend render the form (or an error) up front.
  fastify.post("/set-password/verify", { schema: verifySchema }, async (request, reply) => {
    const resolved = await resolveToken(request.body.token, reply);
    if (!resolved) return;

    const { staff } = resolved;
    return { name: staff.name, labKey: staff.labKey };
  });

  // POST /set-password
  fastify.post("/set-password", { schema: setPasswordSchema }, async (request, reply) => {
    const resolved = await resolveToken(request.body.token, reply);
    if (!resolved) return;

    const { tokenDoc, staff } = resolved;
    const passwordHash = await bcrypt.hash(request.body.password, 12);
    const now = new Date();

    await staffs().updateOne(
      { _id: staff._id },
      { $set: { password: passwordHash, updatedAt: now, "updated.at": Date.now() } },
    );

    // Token has done its job — remove it entirely.
    await passwordSetTokens().deleteOne({ _id: tokenDoc._id });

    // Also purge any other still-live link for this staff member so an
    // older SMS can't be replayed after the password's already set.
    await passwordSetTokens().deleteMany({ staffId: staff._id });

    return { message: "Password set successfully. You can now log in." };
  });
}
