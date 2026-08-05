import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import toObjectId from "../../utils/db.js";

// labKey is a 1-to-5-digit string, e.g. "1", "472", "04721"
const LAB_KEY_PATTERN = /^\d{1,5}$/;
const isValidLabKey = (labKey) => typeof labKey === "string" && LAB_KEY_PATTERN.test(labKey.trim());

// OTP guess-limiting for /reset-password — a 6-digit OTP is only 1,000,000
// combinations; without a cap, an attacker could brute-force it within its
// 10-minute validity window. After MAX_OTP_ATTEMPTS wrong guesses, the OTP
// is invalidated and the person has to request a new one via /forgot-password.
const MAX_OTP_ATTEMPTS = 5;

// Shape used for the `billing` claim embedded in the JWT — kept in one place
// so /login and /refresh can never drift out of sync with each other.
const toBillingClaim = (lab) => ({
  feePerInvoice: lab?.billing?.feePerInvoice ?? 0,
  forceInvoiceFee: !!lab?.billing?.forceInvoiceFee,
});

const deviceSchemaProps = {
  type: "object",
  additionalProperties: false,
  properties: {
    browser: { type: "string", maxLength: 100 },
    browserVersion: { type: "string", maxLength: 50 },
    os: { type: "string", maxLength: 100 },
    osVersion: { type: "string", maxLength: 50 },
    deviceType: { type: "string", maxLength: 50 },
    screenRes: { type: "string", maxLength: 50 },
    timezone: { type: "string", maxLength: 100 },
    language: { type: "string", maxLength: 50 },
  },
};

const loginSchema = {
  schema: {
    tags: ["Auth"],
    summary: "Login",
    body: {
      type: "object",
      required: ["labKey", "phone", "password"],
      additionalProperties: false,
      properties: {
        labKey: { type: "string", pattern: "^\\d{1,5}$" },
        phone: { type: "string", pattern: "^01[0-9]{9}$" },
        password: { type: "string", minLength: 1, maxLength: 100 },
        device: deviceSchemaProps,
      },
    },
  },
};

const forgotPasswordSchema = {
  schema: {
    tags: ["Auth"],
    summary: "Request OTP for password reset",
    body: {
      type: "object",
      required: ["phone", "labKey"],
      additionalProperties: false,
      properties: {
        phone: { type: "string", pattern: "^01[0-9]{9}$" },
        labKey: { type: "string", pattern: "^\\d{1,5}$" },
      },
    },
  },
};

const resetPasswordSchema = {
  schema: {
    tags: ["Auth"],
    summary: "Reset password using OTP",
    body: {
      type: "object",
      required: ["phone", "labKey", "otp", "newPassword"],
      additionalProperties: false,
      properties: {
        phone: { type: "string", pattern: "^01[0-9]{9}$" },
        labKey: { type: "string", pattern: "^\\d{1,5}$" },
        otp: { type: "string", pattern: "^\\d{6}$" },
        newPassword: { type: "string", minLength: 6, maxLength: 60 },
      },
    },
  },
};

async function authRoutes(fastify) {
  const staffsCollection = () => fastify.mongo.db.collection("staffs");
  const tokensCollection = () => fastify.mongo.db.collection("tokens");
  const otpCollection = () => fastify.mongo.db.collection("otps");

  // ── POST /login ───────────────────────────────────────────────────────────
  fastify.post("/login", loginSchema, async (req, reply) => {
    const { labKey, phone, password, device } = req.body || {};
    if (!isValidLabKey(labKey)) {
      return reply.code(400).send({ error: "Lab Key must be a 1-to-5-digit code" });
    }

    const staff = await staffsCollection().findOne({ labKey: String(labKey).trim(), phone });
    // NOTE: staffRoutes.js now hard-deletes staff (previously soft-deleted via
    // a `deletion.status` flag). A deleted staff member simply won't be found
    // by this findOne anymore, so `!staff` already covers that case — the old
    // `staff.deletion?.status` check is removed as dead code.
    if (!staff || !(await bcrypt.compare(password, staff.password)) || !staff.isActive) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const lab = await fastify.mongo.db.collection("labs").findOne(
      { _id: toObjectId(staff.labId) },
      {
        projection: {
          name: 1,
          labKey: 1,
          registrationNumber: 1,
          type: 1,
          isActive: 1,
          "contact.primary": 1,
          "contact.address": 1,
          "contact.publicEmail": 1,
          "billing.feePerInvoice": 1,
          "billing.forceInvoiceFee": 1,
        },
      },
    );

    const grantedPermissions = Object.fromEntries(
      Object.entries(staff.permissions || {}).filter(([, value]) => value === true),
    );

    const payload = {
      id: staff._id.toString(),
      name: staff.name,
      role: staff.role,
      permissions: grantedPermissions,
      // Module-level access list, derived server-side from `permissions` by
      // staffRoutes.js (staff.modules) whenever permissions are set/edited.
      // Falls back to [] for any staff doc from before that field existed
      // (i.e. hasn't had its permissions touched since) rather than throwing.
      modules: staff.modules ?? [],
      labKey: String(staff.labKey),
      labId: staff.labId.toString(),
      type: lab?.type,
      maxLabAdjustment: staff.maxLabAdjustment ?? 0,
      // Snapshotted at login/refresh time — see /refresh for the staleness
      // tradeoff, and the billing-update route for how this gets invalidated.
      billing: toBillingClaim(lab),
    };

    const deviceId = randomUUID();
    const accessToken = await reply.jwtSign(payload);

    const refreshTokenPlain = await fastify.jwt.sign(payload, {
      key: fastify.REFRESH_SECRET,
      expiresIn: fastify.REFRESH_EXPIRY,
    });

    // ── Enforce max 5 concurrent sessions ─────────────────────────────────
    const sessions = await tokensCollection()
      .find({ userId: toObjectId(payload.id) })
      .sort({ createdAt: 1 })
      .toArray();
    if (sessions.length >= 5) {
      await tokensCollection().deleteOne({ _id: sessions[0]._id });
    }

    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
    const userAgent = req.headers["user-agent"] || "unknown";

    const deviceInfo = {
      browser: device?.browser ?? "Unknown",
      browserVersion: device?.browserVersion ?? "",
      os: device?.os ?? "Unknown",
      osVersion: device?.osVersion ?? "",
      deviceType: device?.deviceType ?? "unknown",
      screenRes: device?.screenRes ?? "",
      timezone: device?.timezone ?? "",
      language: device?.language ?? "",
      ip,
      userAgent,
    };

    await tokensCollection().insertOne({
      userId: toObjectId(payload.id),
      labId: toObjectId(payload.labId),
      deviceId,
      refreshToken: fastify.hashToken(refreshTokenPlain),
      device: deviceInfo,
      createdAt: new Date(),
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + fastify.REFRESH_EXPIRY_MS),
    });

    reply
      .setCookie("refreshToken", refreshTokenPlain, fastify.cookieOptions)
      .setCookie("deviceId", deviceId, fastify.cookieOptions);

    return { accessToken, lab };
  });

  // ── POST /forgot-password ─────────────────────────────────────────────────
  fastify.post("/forgot-password", forgotPasswordSchema, async (req, reply) => {
    const { phone, labKey } = req.body || {};
    if (!isValidLabKey(labKey)) {
      return reply.code(400).send({ error: "Lab Key must be a 1-to-5-digit code" });
    }
    const normalizedLabKey = String(labKey).trim();

    const staff = await staffsCollection().findOne({ phone, labKey: normalizedLabKey });

    // NOTE: same dead-code removal as /login above — staff.deletion?.status
    // can no longer exist now that staffRoutes.js hard-deletes.
    if (!staff || !staff.isActive) {
      return reply.send({ message: "If this number is registered, an OTP has been sent." });
    }

    const existing = await otpCollection().findOne({ phone, labKey: normalizedLabKey });
    if (existing) {
      const ageMs = Date.now() - existing.createdAt;
      if (ageMs < 2 * 60 * 1000) {
        return reply.code(429).send({ error: "OTP already sent. Please wait 2 minutes before requesting again." });
      }
      await otpCollection().deleteOne({ _id: existing._id });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));

    await otpCollection().insertOne({
      phone,
      labKey: normalizedLabKey,
      staffId: toObjectId(staff._id),
      otp: fastify.hashToken(otp),
      attempts: 0,
      createdAt: Date.now(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    try {
      await fastify.sendSMS({
        number: phone,
        message: `Your LabPilot password reset OTP is ${otp}. Valid for 10 minutes. Do not share.`,
      });
    } catch (err) {
      fastify.log.error({ err }, "OTP SMS failed");
      await otpCollection().deleteOne({ staffId: toObjectId(staff._id) });
      return reply.code(500).send({ error: "Failed to send OTP. Please try again." });
    }

    return reply.send({ message: "If this number is registered, an OTP has been sent." });
  });

  // ── POST /reset-password ──────────────────────────────────────────────────
  fastify.post("/reset-password", resetPasswordSchema, async (req, reply) => {
    const { phone, labKey, otp, newPassword } = req.body || {};
    if (!isValidLabKey(labKey)) {
      return reply.code(400).send({ error: "Lab Key must be a 1-to-5-digit code" });
    }
    const normalizedLabKey = String(labKey).trim();

    // Look up by phone+labKey first (not by matching the OTP hash directly)
    // so we can track and cap wrong guesses against this specific record —
    // matching by hash up front would mean a wrong guess finds no document
    // at all and there'd be nothing to attach an attempt counter to.
    const record = await otpCollection().findOne({
      phone,
      labKey: normalizedLabKey,
      expiresAt: { $gt: new Date() },
    });

    if (!record) {
      return reply.code(400).send({ error: "Invalid or expired OTP" });
    }

    if (record.attempts >= MAX_OTP_ATTEMPTS) {
      await otpCollection().deleteOne({ _id: record._id });
      return reply.code(429).send({ error: "Too many incorrect attempts. Please request a new OTP." });
    }

    if (record.otp !== fastify.hashToken(otp)) {
      const newAttempts = record.attempts + 1;
      const attemptsLeft = MAX_OTP_ATTEMPTS - newAttempts;

      if (attemptsLeft <= 0) {
        // Last attempt just used — invalidate immediately instead of making
        // the client find out on a wasted 6th request.
        await otpCollection().deleteOne({ _id: record._id });
        return reply.code(429).send({ error: "Too many incorrect attempts. Please request a new OTP." });
      }

      await otpCollection().updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
      return reply.code(400).send({ error: "Invalid or expired OTP", attemptsLeft });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await staffsCollection().updateOne(
      { _id: toObjectId(record.staffId) },
      { $set: { password: hashedPassword, updatedAt: new Date() } },
    );

    await otpCollection().deleteOne({ _id: record._id });
    await tokensCollection().deleteMany({ userId: toObjectId(record.staffId) });

    return reply.send({ message: "Password reset successful. Please log in with your new password." });
  });

  // ── POST /refresh ─────────────────────────────────────────────────────────
  fastify.post("/refresh", async (req, reply) => {
    const { refreshToken, deviceId } = req.cookies || {};
    if (!refreshToken || !deviceId) {
      return reply.code(445).send({ error: "Missing tokens" });
    }

    let decoded;
    try {
      decoded = await fastify.jwt.verify(refreshToken, { key: fastify.REFRESH_SECRET });
    } catch {
      return reply.code(445).send({ error: "Invalid or expired refresh token" });
    }

    const payload = {
      id: decoded.id,
      name: decoded.name,
      role: decoded.role,
      permissions: decoded.permissions,
      // Carried forward from the refresh token as-is, same staleness
      // tradeoff as `permissions`/`billing` below — modules only refresh on
      // the next /login, or immediately if the permissions-update route
      // clears this staff member's sessions (see staffRoutes.js
      // PUT /staff/:id/permissions), which makes refresh fail below and
      // forces a fresh /login with the new modules list.
      modules: decoded.modules ?? [],
      labKey: String(decoded.labKey),
      labId: decoded.labId,
      type: decoded.type,
      maxLabAdjustment: decoded.maxLabAdjustment ?? 0,
      // Snapshotted at login/refresh time — see /refresh for the staleness
      // tradeoff, and the billing-update route for how this gets invalidated.
      billing: decoded.billing ?? { feePerInvoice: 0, forceInvoiceFee: false },
    };

    const existingSession = await tokensCollection().findOne({
      userId: toObjectId(payload.id),
      labId: toObjectId(payload.labId),
      deviceId,
      refreshToken: fastify.hashToken(refreshToken),
      expiresAt: { $gt: new Date() },
    });

    if (!existingSession) {
      const recentSession = await tokensCollection().findOne({
        userId: toObjectId(payload.id),
        labId: toObjectId(payload.labId),
        deviceId,
        lastUsedAt: { $gt: new Date(Date.now() - 30_000) },
        expiresAt: { $gt: new Date() },
      });

      if (!recentSession) {
        return reply.code(445).send({ error: "Session expired or revoked" });
      }

      const newRefreshTokenPlain = await fastify.jwt.sign(payload, {
        key: fastify.REFRESH_SECRET,
        expiresIn: fastify.REFRESH_EXPIRY,
      });

      await tokensCollection().updateOne(
        { _id: recentSession._id },
        {
          $set: {
            refreshToken: fastify.hashToken(newRefreshTokenPlain),
            lastUsedAt: new Date(),
            expiresAt: new Date(Date.now() + fastify.REFRESH_EXPIRY_MS),
          },
        },
      );

      const newAccessToken = await reply.jwtSign(payload);
      reply.setCookie("refreshToken", newRefreshTokenPlain, fastify.cookieOptions);
      return { accessToken: newAccessToken };
    }

    const newRefreshTokenPlain = await fastify.jwt.sign(payload, {
      key: fastify.REFRESH_SECRET,
      expiresIn: fastify.REFRESH_EXPIRY,
    });

    await tokensCollection().updateOne(
      { _id: existingSession._id },
      {
        $set: {
          refreshToken: fastify.hashToken(newRefreshTokenPlain),
          lastUsedAt: new Date(),
          expiresAt: new Date(Date.now() + fastify.REFRESH_EXPIRY_MS),
        },
      },
    );

    const newAccessToken = await reply.jwtSign(payload);
    reply.setCookie("refreshToken", newRefreshTokenPlain, fastify.cookieOptions);

    return { accessToken: newAccessToken };
  });

  // ── POST /logout ──────────────────────────────────────────────────────────
  fastify.post("/logout", async (req, reply) => {
    const { refreshToken, deviceId } = req.cookies || {};

    if (refreshToken && deviceId) {
      let userId;
      try {
        const decoded = fastify.jwt.decode(refreshToken);
        userId = decoded?.id;
      } catch {
        // still clear cookies below
      }

      await tokensCollection().deleteOne({
        ...(userId && { userId: toObjectId(userId) }),
        deviceId,
        refreshToken: fastify.hashToken(refreshToken),
      });
    }

    reply.clearCookie("refreshToken", fastify.cookieOptions).clearCookie("deviceId", fastify.cookieOptions);

    return { message: "Logged out from this device" };
  });

  // ── POST /logout-all ──────────────────────────────────────────────────────
  fastify.post("/logout-all", { onRequest: [fastify.authenticate] }, async (req, reply) => {
    await tokensCollection().deleteMany({
      userId: toObjectId(req.user.id),
      labId: toObjectId(req.user.labId),
    });

    reply.clearCookie("refreshToken", fastify.cookieOptions).clearCookie("deviceId", fastify.cookieOptions);

    return { message: "Logged out from all devices in this lab" };
  });
}

export default authRoutes;
