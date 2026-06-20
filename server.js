import Fastify from "fastify";
import cors from "@fastify/cors";
import mongodb from "@fastify/mongodb";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fastifyCookie from "@fastify/cookie";
import dotenv from "dotenv";

import authPlugin from "./plugins/auth.js";
import smsPlugin from "./plugins/sms.js";
import billingGuardPlugin from "./plugins/billingGuard.js";
import { ensureIndexes } from "./db/indexes.js";

import authRoutes from "./routes/auth/auth.js";
import referrerRoutes from "./routes/referrer/referrer.js";
import staffRoutes from "./routes/staff/staff.js";
import testRoutes from "./routes/test/test.js";
import productRoutes from "./routes/product/product.js";
import invoiceRoutes from "./routes/invoice/invoice.js";
import reportRoutes from "./routes/report/report.js";

// Daily Reports
import cashmemoRoutes from "./routes/dailyReports/cashmemo/cashmemo.js";
import salesReportRoutes from "./routes/dailyReports/salesReport/salesReport.js";
import commissionReportRoutes from "./routes/dailyReports/commissionReport/commissionReport.js";
import collectionReportRoutes from "./routes/dailyReports/collectionReport/collectionReport.js";

import accountRoutes from "./routes/account/account.js";
import billingRoutes from "./routes/billing/billing.js";
import doctorRoutes from "./routes/doctor/doctor.js";
import indoorPatientRoutes from "./routes/indoorPatient/indoorPatient.js";
import admissionSpaceRoutes from "./routes/admissionSpace/admissionSpace.js";

import internalRoutes from "./routes/internal/internal.js";
import departmentRoutes from "./routes/department/department.js";


dotenv.config();

const fastify = Fastify({
  disableRequestLogging: true,
  logger: {
    transport: {
      target: "pino-pretty",
      options: { ignore: "pid,hostname,level,time,reqId,req,res,responseTime" },
    },
  },
});

// ── 1. Cookies
await fastify.register(fastifyCookie);

// ── 2. CORS
await fastify.register(cors, {
  origin: ["https://labpilotpro.com", "https://www.labpilotpro.com", "https://lpadmin.netlify.app", "http://localhost:5173", "http://localhost:5174"],
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});

// ── 3. MongoDB
await fastify.register(mongodb, {
  forceClose: true,
  url: process.env.MONGODB_URI,
  database: "labpilot",
});

// ── 4. DB indexes
try {
  await ensureIndexes(fastify.mongo.db);
  fastify.log.info("DB indexes ensured");
} catch (err) {
  fastify.log.error({ err }, "Could not ensure DB indexes — aborting");
  process.exit(1);
}

// ── 5. Plugins
await fastify.register(authPlugin);
await fastify.register(smsPlugin);
await fastify.register(billingGuardPlugin);

// ── 6. Swagger
await fastify.register(swagger, {
  openapi: {
    info: {
      title: "LabPilot Lab API",
      description: "Lab-facing REST API",
      version: "1.0.0",
    },
    servers: [{ url: `http://localhost:${process.env.LAB_PORT || 3000}` }],
  },
});

await fastify.register(swaggerUi, {
  routePrefix: "/docs",
  uiConfig: { docExpansion: "list", deepLinking: true },
  staticCSP: true,
});

// ── 7. Routes
const API = "/v1";

// Auth
fastify.register(authRoutes, { prefix: API });

// Daily Reports
fastify.register(cashmemoRoutes, { prefix: API });
fastify.register(salesReportRoutes, { prefix: API });
fastify.register(commissionReportRoutes, { prefix: API });
fastify.register(collectionReportRoutes, { prefix: API });

// Referrers
fastify.register(referrerRoutes, { prefix: API });

// Staffs
fastify.register(staffRoutes, { prefix: API });
fastify.register(testRoutes, { prefix: API });
fastify.register(productRoutes, { prefix: API });
fastify.register(invoiceRoutes, { prefix: API });
fastify.register(reportRoutes, { prefix: API });
fastify.register(accountRoutes, { prefix: API });
fastify.register(billingRoutes, { prefix: API });
fastify.register(doctorRoutes , { prefix: API });
fastify.register(indoorPatientRoutes , { prefix: API });
fastify.register(admissionSpaceRoutes , { prefix: API });
fastify.register(departmentRoutes , { prefix: API });

fastify.register(internalRoutes); // no /v1 prefix — internal only

fastify.get("/", async (req, reply) => reply.send("Lab API OK"));

// ── 8. Start
try {
  await fastify.listen({ port: process.env.LAB_PORT || 3000, host: "0.0.0.0" });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}


