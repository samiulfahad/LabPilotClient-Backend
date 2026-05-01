import toObjectId from "../../utils/db.js";

const collectionName = "doctors";

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

// ─── Body Properties ──────────────────────────────────────────────────────────

const doctorBodyProperties = {
  name: { type: "string", minLength: 1, maxLength: 120, description: "Full name of the doctor" },
  degree: { type: "string", maxLength: 200, description: "Academic degree(s) e.g. MBBS, MD (optional)" },
  contactNumber: { type: "string", minLength: 1, maxLength: 20, description: "Phone / contact number" },
  designation: {
    type: "string",
    maxLength: 100,
    description: "Designation e.g. Professor, Consultant (optional)",
  },
  department: {
    type: "string",
    minLength: 1,
    maxLength: 100,
    description: "Department e.g. Cardiology, Medicine",
  },
  commissionType: {
    type: "string",
    enum: ["percentage", "fixed"],
    description: "How commission is calculated",
  },
  commissionValue: {
    type: "number",
    minimum: 0,
    description: "Commission amount (0–100 if percentage, any positive number if fixed BDT)",
  },
  isActive: { type: "boolean", description: "Whether the doctor is active (defaults to true)" },
};

// ─── Route Schemas ────────────────────────────────────────────────────────────

const getAllDoctorsSchema = {
  schema: {
    tags: ["Doctors"],
    summary: "Get all doctors for the lab, with optional search and department filter",
    querystring: {
      type: "object",
      properties: {
        search: {
          type: "string",
          maxLength: 100,
          description: "Search across name, degree, contact, designation, department",
        },
        department: { type: "string", maxLength: 100, description: "Filter by exact department name" },
      },
    },
  },
};

const getDoctorByIdSchema = {
  schema: {
    tags: ["Doctors"],
    summary: "Get a single doctor by ID",
    params: doctorIdParamSchema,
  },
};

const createDoctorSchema = {
  schema: {
    tags: ["Doctors"],
    summary: "Register a new doctor",
    body: {
      type: "object",
      required: ["name", "contactNumber", "department", "commissionType", "commissionValue"],
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
      description: "At least one field must be provided",
      properties: doctorBodyProperties,
    },
  },
};

const deleteDoctorSchema = {
  schema: {
    tags: ["Doctors"],
    summary: "Hard delete a doctor",
    params: doctorIdParamSchema,
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

async function doctorRoutes(fastify) {
  const collection = fastify.mongo.db.collection(collectionName);
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);

  // ── GET /doctors ───────────────────────────────────────────────────────────
  fastify.get("/doctors", getAllDoctorsSchema, async (req, reply) => {
    try {
      const { search, department } = req.query;

      const query = { labId: labId(req) };

      if (search?.trim()) {
        const regex = { $regex: search.trim(), $options: "i" };
        query.$or = [
          { name: regex },
          { degree: regex },
          { contactNumber: regex },
          { designation: regex },
          { department: regex },
        ];
      }

      if (department?.trim()) {
        query.department = department.trim();
      }

      return collection.find(query).sort({ name: 1 }).toArray();
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
      const { name, degree, contactNumber, designation, department, commissionType, commissionValue, isActive } =
        req.body;

      if (commissionType === "percentage" && commissionValue > 100) {
        return reply.code(400).send({ error: "Percentage commission must be between 0 and 100" });
      }

      const result = await collection.insertOne({
        labId: labId(req),
        name,
        degree: degree ?? "",
        contactNumber,
        designation: designation ?? "",
        department,
        commissionType,
        commissionValue,
        isActive: isActive ?? true,
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

      const { name, degree, contactNumber, designation, department, commissionType, commissionValue, isActive } =
        req.body;

      // If both type and value are being updated, validate together
      const effectiveType = commissionType ?? (await collection.findOne({ _id, labId: labId(req) }))?.commissionType;
      if (effectiveType === "percentage" && commissionValue !== undefined && commissionValue > 100) {
        return reply.code(400).send({ error: "Percentage commission must be between 0 and 100" });
      }

      const updateData = {
        ...(name !== undefined && { name }),
        ...(degree !== undefined && { degree }),
        ...(contactNumber !== undefined && { contactNumber }),
        ...(designation !== undefined && { designation }),
        ...(department !== undefined && { department }),
        ...(commissionType !== undefined && { commissionType }),
        ...(commissionValue !== undefined && { commissionValue }),
        ...(isActive !== undefined && { isActive }),
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
