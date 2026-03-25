import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { ObjectId } from "mongodb";

async function authRoutes(fastify) {
  const staffsCollection = () => fastify.mongo.db.collection("staffs");
  const tokensCollection = () => fastify.mongo.db.collection("tokens");

  // ── POST /register ────────────────────────────────────────────────────────
  fastify.post("/register", async (req, reply) => {
    const { labId, labOId, phone, name, password, role, permissions, email } = req.body || {};

    if (!labId || !labOId || !phone || !name || !password || !role || typeof permissions !== "object") {
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
    if (exists) return reply.code(409).send({ error: "Phone already registered in this lab" });

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await staffsCollection().insertOne({
      labOId, // string form of lab's _id
      labId, // numeric short ID (display only)
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
      labOId: staff.labOId, // string — ObjectId is not JSON-serializable
    };

    const deviceId = randomUUID();
    const accessToken = await reply.jwtSign(payload);

    const refreshTokenPlain = await fastify.jwt.sign(payload, {
      key: fastify.REFRESH_SECRET,
      expiresIn: fastify.REFRESH_EXPIRY,
    });

    const sessions = await tokensCollection().find({ userId: payload.id }).sort({ createdAt: 1 }).toArray();
    if (sessions.length >= 5) {
      await tokensCollection().deleteOne({ _id: sessions[0]._id });
    }

    await tokensCollection().insertOne({
      userId: payload.id,
      labOId: payload.labOId, // use labOId as the lab identifier in tokens too
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
      decoded = await fastify.jwt.verify(refreshToken, { key: fastify.REFRESH_SECRET });
    } catch {
      return reply.code(401).send({ error: "Invalid or expired refresh token" });
    }

    const payload = {
      id: decoded.id,
      role: decoded.role,
      permissions: decoded.permissions,
      labId: decoded.labId,
      labOId: decoded.labOId,
    };

    const newRefreshTokenPlain = await fastify.jwt.sign(payload, {
      key: fastify.REFRESH_SECRET,
      expiresIn: fastify.REFRESH_EXPIRY,
    });

    const updatedSession = await tokensCollection().findOneAndUpdate(
      {
        userId: payload.id,
        labOId: payload.labOId,
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
        const decoded = fastify.jwt.decode(refreshToken);
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
      labOId: req.user.labOId,
    });

    reply.clearCookie("refreshToken", fastify.cookieOptions).clearCookie("deviceId", fastify.cookieOptions);

    return { message: "Logged out from all devices in this lab" };
  });
}

export default authRoutes;
