import Fastify from "fastify";
import cors from "@fastify/cors";
import mongodb from "@fastify/mongodb";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import dotenv from "dotenv";
import referrerRoutes from "./routes/referrers.js";

dotenv.config();

const fastify = Fastify({ logger: false });

// CORS
await fastify.register(cors, { origin: true, methods: ["GET", "POST", "PUT", "DELETE", "PATCH"] });

// MongoDB
await fastify.register(mongodb, {
  url: process.env.MONGODB_URI,
});

// Swagger / OpenAPI
await fastify.register(swagger, {
  openapi: {
    info: {
      title: "Referrer Management API",
      description: "REST API for managing medical referrers (doctors, agents, etc.)",
      version: "1.0.0",
      contact: {
        name: "Your Name",
        email: "you@example.com",
      },
    },
    servers: [{ url: `http://localhost:${process.env.PORT || 5000}`, description: "Development server" }],
    tags: [{ name: "Referrers", description: "Referrer management endpoints" }],
  },
});

await fastify.register(swaggerUi, {
  routePrefix: "/docs",
  uiConfig: {
    docExpansion: "list",
    deepLinking: true,
    defaultModelsExpandDepth: 1,
  },
  staticCSP: true,
});

// Routes
fastify.register(referrerRoutes, { prefix: "/api/v1" });

const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT || 5000, host: "0.0.0.0" });
    console.log(`🚀 Server running on http://localhost:${process.env.PORT || 5000}`);
    console.log(`📘 Swagger UI available at http://localhost:${process.env.PORT || 5000}/docs`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();


fastify.get("/", (req, res)=> {
    res.send("Ok")
})
