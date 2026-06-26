/**
 * doctorRoutes.js
 */

import toObjectId from "../../utils/db.js";
import { ALLOWED_DEPARTMENTS, ALLOWED_DESIG_VALUES } from "../staticData/staticData.js";

const collectionName = "doctors";
const PAGE_SIZE = 20;

// ─── Reusable Schema Fragments ────────────────────────────────────────────────

const objectIdSchema = {
  type: "string",
  minLength: 24,
  maxLength: 24,
  description: "MongoDB ObjectId (24-character hex string)",
};

const doctorIdParamSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { ...objectIdSchema, description: "ObjectId of the doctor" },
  },
};

const doctorBodyProperties = {
  name: { type: "string", minLength: 1, maxLength: 120 },
  degree: { type: "string", maxLength: 200 },
  contactNumber: { type: "string", minLength: 1, maxLength: 20 },
  designation: { type: "string", maxLength: 100 },
  departments: {
    type: "array",
    minItems: 1,
    uniqueItems: true,
    items: { type: "string", minLength: 1, maxLength: 100 },
  },
  commissionType: { type: "string", enum: ["percentage", "fixed"] },
  commissionValue: { type: "number", minimum: 0 },
};

// ─── Route Schemas ────────────────────────────────────────────────────────────

const getAllDoctorsSchema = {
  schema: {
    tags: ["Doctors"],
    summary: "Get paginated doctors with optional search and department filter",
    querystring: {
      type: "object",
      properties: {
        search: { type: "string", maxLength: 100 },
        department: { type: "string", maxLength: 100 },
        page: { type: "integer", minimum: 1, default: 1 },
      },
    },
  },
};

const getDoctorByIdSchema = {
  schema: { tags: ["Doctors"], summary: "Get a single doctor by ID", params: doctorIdParamSchema },
};

const createDoctorSchema = {
  schema: {
    tags: ["Doctors"],
    summary: "Register a new doctor",
    body: {
      type: "object",
      required: ["name", "contactNumber", "departments", "commissionType", "commissionValue"],
      additionalProperties: false,
      properties: doctorBodyProperties,
    },
  },
};

const updateDoctorSchema = {
  schema: {
    tags: ["Doctors"],
    summary: "Update an existing doctor",
    params: doctorIdParamSchema,
    body: {
      type: "object",
      required: [],
      additionalProperties: false,
      minProperties: 1,
      properties: doctorBodyProperties,
    },
  },
};

const deleteDoctorSchema = {
  schema: { tags: ["Doctors"], summary: "Hard delete a doctor", params: doctorIdParamSchema },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const validateDepartments = (departments) => departments.filter((d) => !ALLOWED_DEPARTMENTS.has(d));
const validateDesignation = (designation) => designation && !ALLOWED_DESIG_VALUES.has(designation);

// ─── Routes ───────────────────────────────────────────────────────────────────

async function doctorRoutes(fastify) {
  const collection = fastify.mongo.db.collection(collectionName);
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);

  // ── GET /doctors ───────────────────────────────────────────────────────────
  fastify.get("/doctors", getAllDoctorsSchema, async (req, reply) => {
    try {
      const { search, department, page = 1 } = req.query;
      const skip = (page - 1) * PAGE_SIZE;

      const query = { labId: labId(req) };

      if (search?.trim()) {
        const regex = { $regex: search.trim(), $options: "i" };
        query.$or = [
          { name: regex },
          { degree: regex },
          { contactNumber: regex },
          { designation: regex },
          { departments: regex },
        ];
      }

      if (department?.trim()) {
        query.departments = department.trim();
      }

      const [doctors, total] = await Promise.all([
        collection.find(query).sort({ name: 1 }).skip(skip).limit(PAGE_SIZE).toArray(),
        collection.countDocuments(query),
      ]);

      return reply.send({
        doctors,
        total,
        page,
        totalPages: Math.ceil(total / PAGE_SIZE),
        pageSize: PAGE_SIZE,
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch doctors" });
    }
  });

  // ── GET /doctor/:id ────────────────────────────────────────────────────────
  fastify.get("/doctor/:id", getDoctorByIdSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid doctor ID" });

      const doctor = await collection.findOne({ _id, labId: labId(req) });
      if (!doctor) return reply.code(404).send({ error: "Doctor not found" });
      return doctor;
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch doctor" });
    }
  });

  // ── POST /doctor/add ───────────────────────────────────────────────────────
  fastify.post("/doctor/add", createDoctorSchema, async (req, reply) => {
    try {
      const { name, degree, contactNumber, designation, departments, commissionType, commissionValue } = req.body;

      if (commissionType === "percentage" && commissionValue > 100)
        return reply.code(400).send({ error: "Percentage commission must be between 0 and 100" });

      const invalidDepts = validateDepartments(departments);
      if (invalidDepts.length > 0)
        return reply.code(400).send({ error: "Invalid department values", invalid: invalidDepts });

      if (validateDesignation(designation)) return reply.code(400).send({ error: "Invalid designation value" });

      const result = await collection.insertOne({
        labId: labId(req),
        name,
        degree: degree ?? "",
        contactNumber,
        designation: designation ?? "",
        departments,
        commissionType,
        commissionValue,
        created: { at: Date.now(), by: { id: req.user.id, name: req.user.name } },
      });

      return reply.code(201).send({ _id: result.insertedId });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to register doctor" });
    }
  });

  // ── PUT /doctor/edit/:id ───────────────────────────────────────────────────
  fastify.put("/doctor/edit/:id", updateDoctorSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid doctor ID" });

      const { name, degree, contactNumber, designation, departments, commissionType, commissionValue } = req.body;

      if (departments !== undefined) {
        const invalidDepts = validateDepartments(departments);
        if (invalidDepts.length > 0)
          return reply.code(400).send({ error: "Invalid department values", invalid: invalidDepts });
      }

      if (validateDesignation(designation)) return reply.code(400).send({ error: "Invalid designation value" });

      if (commissionType === "percentage" && commissionValue !== undefined && commissionValue > 100)
        return reply.code(400).send({ error: "Percentage commission must be between 0 and 100" });

      // If only commissionValue is patched, check stored type
      if (commissionValue !== undefined && commissionType === undefined) {
        const existing = await collection.findOne({ _id, labId: labId(req) }, { projection: { commissionType: 1 } });
        if (existing?.commissionType === "percentage" && commissionValue > 100)
          return reply.code(400).send({ error: "Percentage commission must be between 0 and 100" });
      }

      const updateData = {
        ...(name !== undefined && { name }),
        ...(degree !== undefined && { degree }),
        ...(contactNumber !== undefined && { contactNumber }),
        ...(designation !== undefined && { designation }),
        ...(departments !== undefined && { departments }),
        ...(commissionType !== undefined && { commissionType }),
        ...(commissionValue !== undefined && { commissionValue }),
        updated: { at: Date.now(), by: { id: req.user.id, name: req.user.name } },
      };

      const result = await collection.updateOne({ _id, labId: labId(req) }, { $set: updateData });
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Doctor not found" });

      return { message: "Doctor updated successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update doctor" });
    }
  });

  // ── DELETE /doctor/:id ─────────────────────────────────────────────────────
  fastify.delete("/doctor/:id", deleteDoctorSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid doctor ID" });

      const result = await collection.deleteOne({ _id, labId: labId(req) });
      if (result.deletedCount === 0) return reply.code(404).send({ error: "Doctor not found" });

      return { message: "Doctor deleted successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to delete doctor" });
    }
  });
}

export default doctorRoutes;
