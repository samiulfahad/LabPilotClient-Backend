import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import toObjectId from "../../utils/db.js";

async function authRoutes(fastify) {
  const staffsCollection = () => fastify.mongo.db.collection("staffs");
  const tokensCollection = () => fastify.mongo.db.collection("tokens");
  const otpCollection = () => fastify.mongo.db.collection("otps");

  // ── POST /register ────────────────────────────────────────────────────────
  fastify.post("/register", async (req, reply) => {
    const { labKey, labId, phone, name, password, role, permissions, email } = req.body || {};

    if (!labKey || !labId || !phone || !name || !password || !role || typeof permissions !== "object") {
      return reply.code(400).send({ error: "Missing required fields" });
    }

    const allowedRoles = ["admin", "staff", "supportAdmin"];
    if (!allowedRoles.includes(role)) {
      return reply.code(400).send({ error: "Invalid role" });
    }

    const allowedPermissions = [
      "createInvoice",
      "editInvoice",
      "deleteInvoice",
      "cashmemo",
      "uploadReport",
      "downloadReport",
    ];
    const cleanPermissions = {};
    for (const perm of allowedPermissions) {
      cleanPermissions[perm] = Boolean(permissions[perm]);
    }

    const exists = await staffsCollection().findOne({ labKey, phone });
    if (exists) return reply.code(409).send({ error: "Phone already registered in this lab" });

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await staffsCollection().insertOne({
      labId: toObjectId(labId),
      labKey,
      name,
      phone,
      password: hashedPassword,
      role,
      permissions: cleanPermissions,
      isActive: true,
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...(email && { email }),
    });

    return { message: "Staff created successfully", id: result.insertedId.toString() };
  });

  // ── POST /login ───────────────────────────────────────────────────────────
  fastify.post("/login", async (req, reply) => {
    const { labKey, phone, password, device } = req.body || {};
    if (!labKey || !phone || !password) {
      return reply.code(400).send({ error: "Missing required fields" });
    }

    const staff = await staffsCollection().findOne({ labKey, phone });
    if (!staff || !(await bcrypt.compare(password, staff.password)) || staff.isDeleted || !staff.isActive) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const payload = {
      id: staff._id.toString(),
      name: staff.name,
      role: staff.role,
      permissions: staff.permissions,
      labKey: staff.labKey,
      labId: staff.labId.toString(),
    };

    const lab = await fastify.mongo.db.collection("labs").findOne(
      { _id: toObjectId(staff.labId) },
      {
        projection: {
          name: 1,
          labKey: 1,
          "contact.primary": 1,
          "contact.address": 1,
          "contact.district": 1,
        },
      },
    );

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
  fastify.post("/forgot-password", async (req, reply) => {
    const { phone, labKey } = req.body || {};
    if (!phone || !labKey) {
      return reply.code(400).send({ error: "Phone and Lab Key are required" });
    }

    const staff = await staffsCollection().findOne({ phone, labKey: Number(labKey) });

    if (!staff || staff.isDeleted || !staff.isActive) {
      return reply.send({ message: "If this number is registered, an OTP has been sent." });
    }

    const existing = await otpCollection().findOne({ phone, labKey: Number(labKey) });
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
      labKey: Number(labKey),
      staffId: toObjectId(staff._id),
      otp: fastify.hashToken(otp),
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
  fastify.post("/reset-password", async (req, reply) => {
    const { phone, labKey, otp, newPassword } = req.body || {};
    if (!phone || !labKey || !otp || !newPassword) {
      return reply.code(400).send({ error: "All fields are required" });
    }
    if (newPassword.length < 6) {
      return reply.code(400).send({ error: "Password must be at least 6 characters" });
    }

    const record = await otpCollection().findOne({
      phone,
      labKey: Number(labKey),
      otp: fastify.hashToken(otp),
      expiresAt: { $gt: new Date() },
    });

    if (!record) {
      return reply.code(400).send({ error: "Invalid or expired OTP" });
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
      labKey: decoded.labKey,
      labId: decoded.labId,
    };

    const newRefreshTokenPlain = await fastify.jwt.sign(payload, {
      key: fastify.REFRESH_SECRET,
      expiresIn: fastify.REFRESH_EXPIRY,
    });

    const updatedSession = await tokensCollection().findOneAndUpdate(
      {
        userId: toObjectId(payload.id),
        labId: toObjectId(payload.labId),
        deviceId,
        refreshToken: fastify.hashToken(refreshToken),
        expiresAt: { $gt: new Date() },
      },
      {
        $set: {
          refreshToken: fastify.hashToken(newRefreshTokenPlain),
          lastUsedAt: new Date(),
          expiresAt: new Date(Date.now() + fastify.REFRESH_EXPIRY_MS),
        },
      },
      { returnDocument: "after" },
    );

    if (!updatedSession) {
      return reply.code(445).send({ error: "Session expired or revoked" });
    }

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
