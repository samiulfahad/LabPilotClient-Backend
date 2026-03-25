// plugins/auth.js
import fastifyJwt from "@fastify/jwt";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import crypto from "crypto";

export default async function authPlugin(fastify) {
  const staffsCollection = () => fastify.mongo.db.collection("staffs");
  const tokensCollection = () => fastify.mongo.db.collection("tokens");

  // === JWT CONFIG FROM ENVIRONMENT VARIABLES ===
  const ACCESS_SECRET = process.env.JWT_SECRET;
  const REFRESH_SECRET = process.env.REFRESH_SECRET;
  const ACCESS_EXPIRY = process.env.JWT_ACCESS_EXPIRY;
  const REFRESH_EXPIRY = process.env.JWT_REFRESH_EXPIRY;

  if (!ACCESS_SECRET || !REFRESH_SECRET || !ACCESS_EXPIRY || !REFRESH_EXPIRY) {
    throw new Error(
      "JWT_SECRET, REFRESH_SECRET, JWT_ACCESS_EXPIRY and JWT_REFRESH_EXPIRY " +
        "environment variables are required for authentication",
    );
  }

  // BUG FIX 2: Parse REFRESH_EXPIRY into ms so DB TTL always matches the JWT expiry.
  // Supports the same units Fastify JWT accepts: s, m, h, d (e.g. "7d", "15m", "1h")
  const parseExpiry = (expiry) => {
    const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    const match = expiry.match(/^(\d+)([smhd])$/);
    if (!match) {
      throw new Error(`Invalid JWT_REFRESH_EXPIRY format: "${expiry}". Use formats like "7d", "15m", "1h".`);
    }
    return parseInt(match[1]) * units[match[2]];
  };

  const REFRESH_EXPIRY_MS = parseExpiry(REFRESH_EXPIRY);

  // === Register Fastify JWT for access tokens (short-lived) ===
  fastify.register(fastifyJwt, {
    secret: ACCESS_SECRET,
    sign: { expiresIn: ACCESS_EXPIRY },
  });

  // === Decorators ===
  fastify.decorate("authenticate", async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      reply.code(401).send({ error: "Unauthorized: Invalid or expired access token" });
    }
  });

  fastify.decorate("authorize", (permission) => async (req, reply) => {
    if (!req.user.permissions?.[permission]) {
      return reply.code(403).send({ error: "Forbidden: Missing required permission" });
    }
  });

  // === Secure cookie options for refresh tokens ===
  const cookieOptions = {
    httpOnly: true,
    path: "/",
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
  };

  // === Helper: hash refresh tokens before storing ===
  const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

  // === MongoDB indexes ===
  await Promise.all([
    tokensCollection().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    tokensCollection().createIndex({ userId: 1, deviceId: 1 }),
    tokensCollection().createIndex({ userId: 1, labId: 1 }),
  ]);

  // ──────────────────────────────
  // 1. REGISTER
  // ──────────────────────────────
  fastify.post("/register", async (req, reply) => {
    const { labId, labOid, phone, name, password, role, permissions, email } = req.body || {};

    if (!labId || !labOid || !phone || !name || !password || !role || typeof permissions !== "object") {
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

    const exists = await staffsCollection().findOne({ labId, phone });
    if (exists) {
      return reply.code(409).send({ error: "Phone already registered in this lab" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // BUG FIX 4: password field was missing — staff could never log in.
    const result = await staffsCollection().insertOne({
      labOid,
      labId,
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

    return {
      message: "Staff created successfully",
      id: result.insertedId.toString(),
    };
  });

  // ──────────────────────────────
  // 2. LOGIN
  // ──────────────────────────────
  fastify.post("/login", async (req, reply) => {
    const { labId, phone, password } = req.body || {};
    if (!labId || !phone || !password) {
      return reply.code(400).send({ error: "Missing required fields" });
    }

    const staff = await staffsCollection().findOne({ labId, phone });

    if (!staff || !(await bcrypt.compare(password, staff.password)) || staff.isDeleted || !staff.isActive) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const payload = {
      id: staff._id.toString(),
      role: staff.role,
      permissions: staff.permissions,
      labId: staff.labId,
      labOid: staff.labOid,
    };

    const deviceId = randomUUID();
    const accessToken = await reply.jwtSign(payload);

    const refreshTokenPlain = await fastify.jwt.sign(payload, {
      key: REFRESH_SECRET,
      expiresIn: REFRESH_EXPIRY,
    });
    const refreshTokenHashed = hashToken(refreshTokenPlain);

    // Enforce max 5 devices: delete oldest session if needed
    const sessions = await tokensCollection().find({ userId: payload.id }).sort({ createdAt: 1 }).toArray();
    if (sessions.length >= 5) {
      await tokensCollection().deleteOne({ _id: sessions[0]._id });
    }

    await tokensCollection().insertOne({
      userId: payload.id,
      labId: payload.labId,
      deviceId,
      refreshToken: refreshTokenHashed,
      createdAt: new Date(),
      // BUG FIX 2: Use REFRESH_EXPIRY_MS so DB TTL matches the JWT expiry from .env
      expiresAt: new Date(Date.now() + REFRESH_EXPIRY_MS),
    });

    reply.setCookie("refreshToken", refreshTokenPlain, cookieOptions).setCookie("deviceId", deviceId, cookieOptions);

    return { accessToken };
  });

  // ──────────────────────────────
  // 3. REFRESH (rotate tokens)
  // ──────────────────────────────
  fastify.post("/refresh", async (req, reply) => {
    const { refreshToken, deviceId } = req.cookies || {};
    if (!refreshToken || !deviceId) {
      return reply.code(401).send({ error: "Missing tokens" });
    }

    let decoded;
    try {
      decoded = await fastify.jwt.verify(refreshToken, { key: REFRESH_SECRET });
    } catch {
      return reply.code(401).send({ error: "Invalid or expired refresh token" });
    }

    const refreshTokenHashed = hashToken(refreshToken);

    const payload = {
      id: decoded.id,
      role: decoded.role,
      permissions: decoded.permissions,
      labId: decoded.labId,
      labOid: decoded.labOid,
    };

    const newRefreshTokenPlain = await fastify.jwt.sign(payload, {
      key: REFRESH_SECRET,
      expiresIn: REFRESH_EXPIRY,
    });
    const newRefreshTokenHashed = hashToken(newRefreshTokenPlain);

    const updatedSession = await tokensCollection().findOneAndUpdate(
      {
        userId: payload.id,
        labId: payload.labId,
        deviceId,
        refreshToken: refreshTokenHashed,
        expiresAt: { $gt: new Date() },
      },
      {
        $set: {
          refreshToken: newRefreshTokenHashed,
          createdAt: new Date(),
          // BUG FIX 2: Use REFRESH_EXPIRY_MS here too
          expiresAt: new Date(Date.now() + REFRESH_EXPIRY_MS),
        },
      },
      { returnDocument: "after" },
    );

    if (!updatedSession) {
      return reply.code(401).send({ error: "Session expired or revoked" });
    }

    const newAccessToken = await reply.jwtSign(payload);
    reply.setCookie("refreshToken", newRefreshTokenPlain, cookieOptions);

    return { accessToken: newAccessToken };
  });

  // ──────────────────────────────
  // 4. LOGOUT (single device)
  // ──────────────────────────────
  fastify.post("/logout", async (req, reply) => {
    const { refreshToken, deviceId } = req.cookies || {};

    if (refreshToken && deviceId) {
      let userId;
      try {
        // Decode without verifying expiry — we just need the userId for scoping
        const decoded = fastify.jwt.decode(refreshToken);
        userId = decoded?.id;
      } catch {
        // Decoding failed — still clear cookies below
      }

      // BUG FIX 3: Scope delete to userId so one user can't terminate another's session
      await tokensCollection().deleteOne({
        ...(userId && { userId }),
        deviceId,
        refreshToken: hashToken(refreshToken),
      });
    }

    reply.clearCookie("refreshToken", cookieOptions).clearCookie("deviceId", cookieOptions);
    return { message: "Logged out from this device" };
  });

  // ──────────────────────────────
  // 5. LOGOUT ALL DEVICES
  // ──────────────────────────────
  fastify.post("/logout-all", { onRequest: [fastify.authenticate] }, async (req, reply) => {
    await tokensCollection().deleteMany({
      userId: req.user.id,
      labId: req.user.labId,
    });
    reply.clearCookie("refreshToken", cookieOptions).clearCookie("deviceId", cookieOptions);
    return { message: "Logged out from all devices in this lab" };
  });
}
