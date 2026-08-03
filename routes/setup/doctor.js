/**
 * doctorRoutes.js
 *
 * Audited — no functional bugs found. All routes correctly scope by labId,
 * validate departments/designation against the allowed static-data sets, and
 * cap percentage commission at 100. One design note (not a bug, not changed):
 * DELETE /doctor/:id is a hard delete with no check for doctors currently
 * supervising admitted patients. This is safe because indoorPatients stores a
 * denormalized snapshot ({doctorId, name, degree}) at admit/change-doctor
 * time rather than a live join, so deleting a doctor won't corrupt existing
 * patient records — but it will leave a dangling doctorId that can no longer
 * be resolved if you ever try to look the doctor up again. Confirm this
 * matches intended behavior.
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

// Basic-info edit only. commissionType/commissionValue are intentionally
// absent — commission has its own dedicated route below (mirrors the
// frontend, which edits it in a separate CommissionModal), same split as
// referrerRoutes.js.
const updateDoctorSchema = {
  schema: {
    tags: ["Doctors"],
    summary: "Update a doctor's basic info",
    params: doctorIdParamSchema,
    body: {
      type: "object",
      required: [],
      additionalProperties: false,
      minProperties: 1,
      description: "At least one field must be provided",
      properties: {
        name: doctorBodyProperties.name,
        degree: doctorBodyProperties.degree,
        contactNumber: doctorBodyProperties.contactNumber,
        designation: doctorBodyProperties.designation,
        departments: doctorBodyProperties.departments,
      },
    },
  },
};

// Dedicated route for commission edits only.
const updateCommissionSchema = {
  schema: {
    tags: ["Doctors"],
    summary: "Update a doctor's commission",
    params: doctorIdParamSchema,
    body: {
      type: "object",
      required: ["commissionType", "commissionValue"],
      additionalProperties: false,
      properties: {
        commissionType: doctorBodyProperties.commissionType,
        commissionValue: doctorBodyProperties.commissionValue,
      },
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
  fastify.addHook("onRequest", fastify.authorize("manageDoctors"));

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
        created: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
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

      const { name, degree, contactNumber, designation, departments } = req.body;

      if (departments !== undefined) {
        const invalidDepts = validateDepartments(departments);
        if (invalidDepts.length > 0)
          return reply.code(400).send({ error: "Invalid department values", invalid: invalidDepts });
      }

      if (validateDesignation(designation)) return reply.code(400).send({ error: "Invalid designation value" });

      const updateData = {
        ...(name !== undefined && { name }),
        ...(degree !== undefined && { degree }),
        ...(contactNumber !== undefined && { contactNumber }),
        ...(designation !== undefined && { designation }),
        ...(departments !== undefined && { departments }),
        updated: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
      };

      const result = await collection.updateOne({ _id, labId: labId(req) }, { $set: updateData });
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Doctor not found" });

      return { message: "Doctor updated successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update doctor" });
    }
  });

  // ── PUT /doctor/:id/commission ────────────────────────────────────────────
  fastify.put("/doctor/:id/commission", updateCommissionSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid doctor ID" });

      const { commissionType, commissionValue } = req.body;

      if (commissionType === "percentage" && commissionValue > 100)
        return reply.code(400).send({ error: "Percentage commission must be between 0 and 100" });

      const result = await collection.updateOne(
        { _id, labId: labId(req) },
        {
          $set: {
            commissionType,
            commissionValue,
            updated: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
          },
        },
      );
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Doctor not found" });

      return { message: "Commission updated successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update commission" });
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
