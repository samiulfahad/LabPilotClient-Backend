// plugins/auth.js
import fastifyJwt from "@fastify/jwt";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import crypto from "crypto";

// Auth plugin for lab-specific STAFF (replaces old "users" collection)
// Supports 3 role types: admin / staff / supportAdmin
// Stores permissions as a separate object (role is now a string)
export default async function authPlugin(fastify) {
  const staffsCollection = () => fastify.mongo.db.collection("staffs");
  const tokensCollection = () => fastify.mongo.db.collection("tokens");

  // === JWT CONFIG FROM ENVIRONMENT VARIABLES ===
  const ACCESS_SECRET = process.env.JWT_SECRET;
  const REFRESH_SECRET = process.env.REFRESH_SECRET;
  const ACCESS_EXPIRY = process.env.JWT_ACCESS_EXPIRY; // e.g. "15m"
  const REFRESH_EXPIRY = process.env.JWT_REFRESH_EXPIRY; // e.g. "7d"

  if (!ACCESS_SECRET || !REFRESH_SECRET || !ACCESS_EXPIRY || !REFRESH_EXPIRY) {
    throw new Error(
      "JWT_SECRET, REFRESH_SECRET, JWT_ACCESS_EXPIRY and JWT_REFRESH_EXPIRY " +
        "environment variables are required for authentication",
    );
  }

  // === Register Fastify JWT for access tokens (short-lived) ===
  fastify.register(fastifyJwt, {
    secret: ACCESS_SECRET,
    sign: { expiresIn: ACCESS_EXPIRY }, // ← now comes from .env
  });

  // === Decorators ===
  // Authenticate decorator: verifies the access token
  fastify.decorate("authenticate", async (req, reply) => {
    try {
      await req.jwtVerify(); // automatically populates req.user
    } catch {
      reply.code(401).send({ error: "Unauthorized: Invalid or expired access token" });
    }
  });

  // Authorize decorator: checks permissions object (role is now a string)
  fastify.decorate("authorize", (permission) => async (req, reply) => {
    if (!req.user.permissions?.[permission]) {
      return reply.code(403).send({ error: "Forbidden: Missing required permission" });
    }
  });

  // === Secure cookie options for refresh tokens ===
  const cookieOptions = {
    httpOnly: true, // not accessible via JavaScript
    path: "/", // available site-wide
    sameSite: "strict", // prevent CSRF
    secure: process.env.NODE_ENV === "production", // HTTPS only in production
  };

  // === Helper function: hash refresh tokens for secure storage ===
  const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

  // === MongoDB indexes ===
  // These ensure efficient queries and automatic TTL cleanup of expired tokens
  await Promise.all([
    tokensCollection().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }), // auto-remove expired tokens
    tokensCollection().createIndex({ userId: 1, deviceId: 1 }), // quick lookup per device
    tokensCollection().createIndex({ userId: 1, labId: 1 }), // quick lookup per lab
  ]);

  // ──────────────────────────────
  // 1. REGISTER (now for STAFF)
  // ──────────────────────────────
  fastify.post("/register", async (req, reply) => {
    const { labId, labOid, phone, name, password, role, permissions, email } = req.body || {};

    if (!labId || !labOid || !phone || !name || !password || !role || typeof permissions !== "object") {
      return reply.code(400).send({ error: "Missing required fields" });
    }

    // Validate allowed roles
    const allowedRoles = ["admin", "staff", "supportAdmin"];
    if (!allowedRoles.includes(role)) {
      return reply.code(400).send({ error: "Invalid role" });
    }

    // Whitelist allowed permissions (exact keys from your schema)
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

    // Check if the phone number already exists in this lab
    const exists = await staffsCollection().findOne({ labId, phone });
    if (exists) {
      return reply.code(409).send({ error: "Phone already registered in this lab" });
    }

    // Hash password before storing
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert new staff
    const result = await staffsCollection().insertOne({
      labOid,
      labId,
      name,
      phone,
      role, // string: "admin" | "staff" | "supportAdmin"
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

    // Combined check: invalid credentials OR inactive/deleted account
    if (!staff || !(await bcrypt.compare(password, staff.password)) || staff.isDeleted || !staff.isActive) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    // JWT payload includes everything needed for authorization
    const payload = {
      id: staff._id.toString(),
      role: staff.role,
      permissions: staff.permissions,
      labId: staff.labId,
      labOid: staff.labOid,
    };

    const deviceId = randomUUID(); // unique identifier for this device/session

    // Create access token (short-lived) – expiry now comes from .env
    const accessToken = await reply.jwtSign(payload);

    // Create refresh token (long-lived) – expiry now comes from .env
    const refreshTokenPlain = await fastify.jwt.sign(payload, {
      key: REFRESH_SECRET,
      expiresIn: REFRESH_EXPIRY, // ← from .env
    });
    const refreshTokenHashed = hashToken(refreshTokenPlain);

    // Enforce max 5 devices: delete oldest session if needed
    const sessions = await tokensCollection().find({ userId: payload.id }).sort({ createdAt: 1 }).toArray();

    if (sessions.length >= 5) {
      await tokensCollection().deleteOne({ _id: sessions[0]._id });
    }

    // Store refresh token session in DB
    await tokensCollection().insertOne({
      userId: payload.id,
      labId: payload.labId,
      deviceId,
      refreshToken: refreshTokenHashed,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // TTL still matches REFRESH_EXPIRY
    });

    // Set refresh token and device ID as cookies
    reply.setCookie("refreshToken", refreshTokenPlain, cookieOptions).setCookie("deviceId", deviceId, cookieOptions);

    return { accessToken };
  });

  // ──────────────────────────────
  // 3. REFRESH (rotate tokens) – MongoDB driver v7+ compatible
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

    // Generate a new refresh token (rotate) – expiry now comes from .env
    const newRefreshTokenPlain = await fastify.jwt.sign(payload, {
      key: REFRESH_SECRET,
      expiresIn: REFRESH_EXPIRY, // ← from .env
    });
    const newRefreshTokenHashed = hashToken(newRefreshTokenPlain);

    // Atomic update to prevent reuse or race conditions
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
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      },
      { returnDocument: "after" }, // MongoDB driver v7+ returns the document directly
    );

    if (!updatedSession) {
      return reply.code(401).send({ error: "Session expired or revoked" });
    }

    // Issue new access token
    const newAccessToken = await reply.jwtSign(payload);

    // Update cookie with rotated refresh token
    reply.setCookie("refreshToken", newRefreshTokenPlain, cookieOptions);

    return { accessToken: newAccessToken };
  });

  // ──────────────────────────────
  // 4. LOGOUT (single device)
  // ──────────────────────────────
  fastify.post("/logout", async (req, reply) => {
    const { refreshToken, deviceId } = req.cookies || {};
    if (refreshToken && deviceId) {
      await tokensCollection().deleteOne({
        deviceId,
        refreshToken: hashToken(refreshToken),
      });
    }
    reply.clearCookie("refreshToken", cookieOptions).clearCookie("deviceId", cookieOptions);
    return { message: "Logged out from this device" };
  });

  // ──────────────────────────────
  // 5. LOGOUT ALL DEVICES (lab-specific)
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
