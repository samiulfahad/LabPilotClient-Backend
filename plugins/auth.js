import fastifyJwt from "@fastify/jwt";
import crypto from "crypto";
import fp from "fastify-plugin";

async function authPlugin(fastify) {
  const tokensCollection = () => fastify.mongo.db.collection("tokens");

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
    if (!match) throw new Error(`Invalid expiry format: "${expiry}". Use formats like "7d", "15m", "1h".`);
    return parseInt(match[1]) * units[match[2]];
  };

  const REFRESH_EXPIRY_MS = parseExpiry(REFRESH_EXPIRY);

  // ── Access token JWT instance (default, no namespace) ─────────────────────
  // reply.jwtSign / request.jwtVerify use ACCESS_SECRET
  await fastify.register(fastifyJwt, {
    secret: ACCESS_SECRET,
    sign: { expiresIn: ACCESS_EXPIRY },
  });

  // ── Refresh token JWT instance (namespaced) ───────────────────────────────
  // Per the official @fastify/jwt docs, registering with a namespace gives each
  // instance its own isolated secret and decorates the instance with:
  //   reply.refreshJwtSign(payload)
  //   request.refreshJwtVerify()
  //   request.refreshJwtDecode()
  // This is the correct way to use two different secrets in one app — the old
  // approach of passing { key: REFRESH_SECRET } to fastify.jwt.sign/verify is
  // not a supported API and is silently ignored, causing every refresh to sign
  // and verify with ACCESS_SECRET, making refresh tokens expire in 1 minute.
  await fastify.register(fastifyJwt, {
    secret: REFRESH_SECRET,
    sign: { expiresIn: REFRESH_EXPIRY },
    namespace: "refresh",
    jwtSign: "refreshJwtSign",
    jwtVerify: "refreshJwtVerify",
    jwtDecode: "refreshJwtDecode",
  });

  // ── Decorators ────────────────────────────────────────────────────────────

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

  fastify.decorate("hashToken", (token) => crypto.createHash("sha256").update(token).digest("hex"));

  fastify.decorate("REFRESH_EXPIRY_MS", REFRESH_EXPIRY_MS);

  fastify.decorate("cookieOptions", {
    httpOnly: true,
    path: "/",
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
  });

  // ── Indexes ───────────────────────────────────────────────────────────────
  await Promise.all([
    tokensCollection().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    tokensCollection().createIndex({ userId: 1, deviceId: 1 }),
    tokensCollection().createIndex({ userId: 1, labId: 1 }),
  ]);
}

export default fp(authPlugin);
