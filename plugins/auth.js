import fastifyJwt from "@fastify/jwt";
import crypto from "crypto";
import fp from "fastify-plugin";

async function authPlugin(fastify) {
  const tokensCollection = () => fastify.mongo.db.collection("tokens");
  const otpCollection = () => fastify.mongo.db.collection("otps");

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

  const parseExpiry = (expiry) => {
    const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    const match = expiry.match(/^(\d+)([smhd])$/);
    if (!match) throw new Error(`Invalid JWT_REFRESH_EXPIRY format: "${expiry}". Use formats like "7d", "15m", "1h".`);
    return parseInt(match[1]) * units[match[2]];
  };

  const REFRESH_EXPIRY_MS = parseExpiry(REFRESH_EXPIRY);

  await fastify.register(fastifyJwt, {
    secret: ACCESS_SECRET,
    sign: { expiresIn: ACCESS_EXPIRY },
  });

  // 444 = expired/invalid access token → frontend will attempt refresh
  fastify.decorate("authenticate", async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(444).send({ error: "Access token invalid or expired" });
    }
  });

  fastify.decorate("authorize", (permission) => async (req, reply) => {
    if (!req.user.permissions?.[permission]) {
      return reply.code(403).send({ error: "Forbidden: Missing required permission" });
    }
  });

  fastify.decorate("hashToken", (token) => crypto.createHash("sha256").update(token).digest("hex"));
  fastify.decorate("REFRESH_SECRET", REFRESH_SECRET);
  fastify.decorate("REFRESH_EXPIRY", REFRESH_EXPIRY);
  fastify.decorate("REFRESH_EXPIRY_MS", REFRESH_EXPIRY_MS);

  // ✅ sameSite: "none" + secure: true → required for cross-origin cookies
  // ✅ maxAge → cookie survives browser restarts, won't be a session cookie
  fastify.decorate("cookieOptions", {
    httpOnly: true,
    path: "/",
    sameSite: "none",
    secure: true,
    maxAge: Math.floor(REFRESH_EXPIRY_MS / 1000),
  });

  await Promise.all([
    tokensCollection().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    tokensCollection().createIndex({ userId: 1, deviceId: 1 }),
    tokensCollection().createIndex({ userId: 1, labId: 1 }),
    otpCollection().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    otpCollection().createIndex({ phone: 1, labKey: 1 }),
  ]);
}

export default fp(authPlugin);