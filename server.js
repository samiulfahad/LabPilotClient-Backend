import Fastify from "fastify";
import cors from "@fastify/cors";
import mongodb from "@fastify/mongodb";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fastifyCookie from "@fastify/cookie";
import dotenv from "dotenv";

import { ensureIndexes } from "./db/indexes.js";
import authPlugin from "./plugins/auth.js";
import authRoutes from "./routes/auth/auth.js";
import referrerRoutes from "./routes/referrer/referrer.js";
import staffRoutes from "./routes/staff/staff.js";
import testRoutes from "./routes/test/test.js";
import invoiceRoutes from "./routes/invoice/invoice.js";
import reportRoutes from "./routes/report/report.js";
import cashmemoRoutes from "./routes/cashmemo/cashmemo.js";
import commissionRoutes from "./routes/commission/commission.js";

dotenv.config();

const fastify = Fastify({
  disableRequestLogging: true,
  logger: {
    transport: {
      target: "pino-pretty",
      options: {
        ignore: "pid,hostname,level,time,reqId,req,res,responseTime",
      },
    },
  },
});

// ── 1. Cookie plugin — must be first so reply.setCookie is available everywhere
await fastify.register(fastifyCookie);

// ── 2. CORS — must be before routes so preflight OPTIONS requests are handled
await fastify.register(cors, {
  origin: [
    "https://sfahad.netlify.app",
    "https://sfahad-admin.netlify.app",
    "http://localhost:5173",
    "http://localhost:5174",
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  credentials: true,
});

// ── 3. MongoDB
await fastify.register(mongodb, {
  url: process.env.MONGODB_URI,
  database: "labpilot",
});

// ── 4. Ensure DB indexes
try {
  await ensureIndexes(fastify.mongo.db);
  fastify.log.info("DB indexes ensured");
} catch (err) {
  fastify.log.error({ err }, "Could not ensure DB indexes — aborting");
  process.exit(1);
}

// ── 5. Auth plugin (decorates fastify.authenticate, fastify.authorize, etc.)
await fastify.register(authPlugin);

// ── 6. Swagger
await fastify.register(swagger, {
  openapi: {
    info: {
      title: "LabPilot API",
      description: "REST API for LabPilot Pro",
      version: "1.0.0",
    },
    servers: [
      {
        url: `http://localhost:${process.env.PORT || 5000}`,
        description: "Development server",
      },
    ],
  },
});

await fastify.register(swaggerUi, {
  routePrefix: "/docs",
  uiConfig: { docExpansion: "list", deepLinking: true },
  staticCSP: true,
});

// ── 7. Routes
const API = "/api/v1";

fastify.register(authRoutes, { prefix: API });
fastify.register(cashmemoRoutes, { prefix: API });
fastify.register(commissionRoutes, { prefix: API });
fastify.register(referrerRoutes, { prefix: API });
fastify.register(staffRoutes, { prefix: API });
fastify.register(testRoutes, { prefix: API });
fastify.register(invoiceRoutes, { prefix: API });
fastify.register(reportRoutes, { prefix: API });

fastify.get("/", (req, reply) => reply.send("Ok"));

try {
  await fastify.listen({ port: process.env.PORT || 5000, host: "0.0.0.0" });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}