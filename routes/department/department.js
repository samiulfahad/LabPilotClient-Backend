/**
 * departmentRoutes.js
 * Medical Departments management for multi-hospital health system.
 * Each hospital (labId) maintains its own active department list,
 * seeded from the canonical ALLOWED_DEPARTMENTS whitelist.
 */

import toObjectId from "../../utils/db.js";

const collectionName = "departments";

// ─── Canonical Department Whitelist ───────────────────────────────────────────
// The backend enforces this list; the frontend mirrors it for the multi-select UI.

export const ALLOWED_DEPARTMENTS = [
  { value: "general", label: "General Medicine" },
  { value: "emergency", label: "Emergency Medicine" },
  { value: "icu", label: "ICU / Critical Care" },
  { value: "surgery", label: "General Surgery" },
  { value: "cardiology", label: "Cardiology" },
  { value: "neurology", label: "Neurology" },
  { value: "psychiatry", label: "Psychiatry" },
  { value: "orthopedics", label: "Orthopedics" },
  { value: "gynecology", label: "Gynecology & Obstetrics" },
  { value: "pediatrics", label: "Pediatrics" },
  { value: "oncology", label: "Oncology" },
  { value: "urology", label: "Urology" },
  { value: "nephrology", label: "Nephrology" },
  { value: "gastroenterology", label: "Gastroenterology" },
  { value: "pulmonology", label: "Pulmonology" },
  { value: "endocrinology", label: "Endocrinology" },
  { value: "rheumatology", label: "Rheumatology" },
  { value: "hematology", label: "Hematology" },
  { value: "dermatology", label: "Dermatology" },
  { value: "ophthalmology", label: "Ophthalmology" },
  { value: "ent", label: "ENT (Ear, Nose & Throat)" },
  { value: "radiology", label: "Radiology & Imaging" },
  { value: "pathology", label: "Pathology & Lab" },
  { value: "anesthesiology", label: "Anesthesiology" },
  { value: "physiotherapy", label: "Physiotherapy & Rehab" },
  { value: "dentistry", label: "Dentistry" },
  { value: "nutrition", label: "Nutrition & Dietetics" },
  { value: "other", label: "Other" },
];

const ALLOWED_VALUES = new Set(ALLOWED_DEPARTMENTS.map((d) => d.value));

// ─── Reusable Schema Fragments ────────────────────────────────────────────────

const getAllDepartmentsSchema = {
  schema: {
    tags: ["Departments"],
    summary: "Get all active departments for this hospital",
  },
};

const getAllowedDepartmentsSchema = {
  schema: {
    tags: ["Departments"],
    summary: "Get the full canonical list of allowed department values (no auth required)",
  },
};

const setDepartmentsSchema = {
  schema: {
    tags: ["Departments"],
    summary: "Replace the hospital's active department list (multi-select save)",
    body: {
      type: "object",
      required: ["departments"],
      additionalProperties: false,
      properties: {
        departments: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: {
            type: "string",
            minLength: 1,
            maxLength: 60,
          },
          description: "Array of department values from the canonical whitelist",
        },
      },
    },
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

async function departmentRoutes(fastify) {
  const collection = fastify.mongo.db.collection(collectionName);
  const labId = (req) => toObjectId(req.user.labId);

  // ── GET /departments/allowed — public, no auth ─────────────────────────────
  fastify.get("/departments/allowed", getAllowedDepartmentsSchema, async (_req, reply) => {
    return reply.send({ departments: ALLOWED_DEPARTMENTS });
  });

  // All routes below require authentication
  fastify.addHook("onRequest", fastify.authenticate);

  // ── GET /departments ────────────────────────────────────────────────────────
  // Returns the hospital's saved active departments (or seeds from whitelist on first call)
  fastify.get("/departments", getAllDepartmentsSchema, async (req, reply) => {
    try {
      const doc = await collection.findOne({ labId: labId(req) });

      if (!doc) {
        // First-time: auto-seed a sensible default set
        const defaults = ["general", "emergency", "icu"];
        const seed = {
          labId: labId(req),
          departments: defaults,
          created: { at: Date.now(), by: { id: req.user.id, name: req.user.name } },
          updated: { at: Date.now(), by: { id: req.user.id, name: req.user.name } },
        };
        await collection.insertOne(seed);
        return reply.send({ departments: defaults });
      }

      return reply.send({ departments: doc.departments });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch departments" });
    }
  });

  // ── POST /departments/set ───────────────────────────────────────────────────
  // Replaces the hospital's active department list (idempotent upsert)
  fastify.post("/departments/set", setDepartmentsSchema, async (req, reply) => {
    try {
      const { departments } = req.body;

      // Validate every value against the canonical whitelist
      const invalid = departments.filter((d) => !ALLOWED_VALUES.has(d));
      if (invalid.length > 0) {
        return reply.code(400).send({
          error: "Invalid department values",
          invalid,
          allowed: [...ALLOWED_VALUES],
        });
      }

      await collection.updateOne(
        { labId: labId(req) },
        {
          $set: {
            departments,
            updated: { at: Date.now(), by: { id: req.user.id, name: req.user.name } },
          },
          $setOnInsert: {
            labId: labId(req),
            created: { at: Date.now(), by: { id: req.user.id, name: req.user.name } },
          },
        },
        { upsert: true },
      );

      return reply.send({ message: "Departments updated successfully", departments });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update departments" });
    }
  });
}

export default departmentRoutes;
