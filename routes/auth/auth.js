import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";

async function authRoutes(fastify) {
  const staffsCollection = () => fastify.mongo.db.collection("staffs");
  const tokensCollection = () => fastify.mongo.db.collection("tokens");

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
      labId,
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
    const { labKey, phone, password } = req.body || {};
    if (!labKey || !phone || !password) {
      return reply.code(400).send({ error: "Missing required fields" });
    }

    const staff = await staffsCollection().findOne({ labKey, phone });
    if (!staff || !(await bcrypt.compare(password, staff.password)) || staff.isDeleted || !staff.isActive) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const payload = {
      id: staff._id.toString(),
      role: staff.role,
      permissions: staff.permissions,
      labKey: staff.labKey,
      labId: staff.labId,
    };

    const deviceId = randomUUID();

    // Access token — signed by @fastify/jwt with ACCESS_SECRET
    const accessToken = await reply.jwtSign(payload);

    // ✅ Refresh token — signed by jsonwebtoken directly with REFRESH_SECRET.
    //    Previously used fastify.jwt.sign(payload, { key: REFRESH_SECRET }) which
    //    silently ignored the { key } option and signed with ACCESS_SECRET instead,
    //    making every subsequent refresh verification fail.
    const refreshTokenPlain = fastify.signRefreshToken(payload);

    // Cap sessions per user at 5 (evict oldest)
    const sessions = await tokensCollection().find({ userId: payload.id }).sort({ createdAt: 1 }).toArray();
    if (sessions.length >= 5) {
      await tokensCollection().deleteOne({ _id: sessions[0]._id });
    }

    await tokensCollection().insertOne({
      userId: payload.id,
      labId: payload.labId,
      deviceId,
      refreshToken: fastify.hashToken(refreshTokenPlain),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + fastify.REFRESH_EXPIRY_MS),
    });

    reply
      .setCookie("refreshToken", refreshTokenPlain, fastify.cookieOptions)
      .setCookie("deviceId", deviceId, fastify.cookieOptions);

    return { accessToken };
  });

  // ── POST /refresh ─────────────────────────────────────────────────────────
  fastify.post("/refresh", async (req, reply) => {
    const { refreshToken, deviceId } = req.cookies || {};
    if (!refreshToken || !deviceId) {
      return reply.code(401).send({ error: "Missing tokens" });
    }

    let decoded;
    try {
      // ✅ verifyRefreshToken uses jsonwebtoken.verify with REFRESH_SECRET directly.
      //    Previously used fastify.jwt.verify(token, { key: REFRESH_SECRET }) which
      //    ignored { key } and verified against ACCESS_SECRET — always throwing a
      //    signature error since the token was signed with a different secret.
      decoded = fastify.verifyRefreshToken(refreshToken);
    } catch {
      return reply.code(401).send({ error: "Invalid or expired refresh token" });
    }

    const payload = {
      id: decoded.id,
      role: decoded.role,
      permissions: decoded.permissions,
      labKey: decoded.labKey,
      labId: decoded.labId,
    };

    const newRefreshTokenPlain = fastify.signRefreshToken(payload);

    const updatedSession = await tokensCollection().findOneAndUpdate(
      {
        userId: payload.id,
        labId: payload.labId,
        deviceId,
        refreshToken: fastify.hashToken(refreshToken),
        expiresAt: { $gt: new Date() },
      },
      {
        $set: {
          refreshToken: fastify.hashToken(newRefreshTokenPlain),
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + fastify.REFRESH_EXPIRY_MS),
        },
      },
      { returnDocument: "after" },
    );

    if (!updatedSession) {
      return reply.code(401).send({ error: "Session expired or revoked" });
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
        // ✅ use decodeToken (no verification needed for logout — we just need the userId)
        const decoded = fastify.decodeToken(refreshToken);
        userId = decoded?.id;
      } catch {
        // still clear cookies below
      }

      await tokensCollection().deleteOne({
        ...(userId && { userId }),
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
      userId: req.user.id,
      labId: req.user.labId,
    });

    reply.clearCookie("refreshToken", fastify.cookieOptions).clearCookie("deviceId", fastify.cookieOptions);

    return { message: "Logged out from all devices in this lab" };
  });
}

export default authRoutes;
