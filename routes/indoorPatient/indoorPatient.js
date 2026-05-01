import toObjectId from "../../utils/db.js";

const collectionName = "indoorPatients";
const PAGE_SIZE = 20;

// ─── Reusable Schema Fragments ────────────────────────────────────────────────

const objectIdSchema = {
  type: "string",
  minLength: 24,
  maxLength: 24,
  description: "MongoDB ObjectId (24-character hex string)",
};

const patientIdParamSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { ...objectIdSchema, description: "ObjectId of the indoor patient" },
  },
};

// ─── Body Properties ──────────────────────────────────────────────────────────

const patientBodyProperties = {
  name: { type: "string", minLength: 1, maxLength: 150 },
  age: { type: "number", minimum: 0, maximum: 150 },
  gender: { type: "string", enum: ["male", "female", "other"] },
  bloodGroup: {
    type: "string",
    enum: ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"],
  },
  contactNumber: { type: "string", maxLength: 20 },
  address: { type: "string", maxLength: 500 },
  nid: { type: "string", maxLength: 30 },

  guardianName: { type: "string", maxLength: 150 },
  guardianRelation: { type: "string", maxLength: 60 },
  guardianContact: { type: "string", maxLength: 20 },

  admissionDate: { type: "number", description: "Admission timestamp (ms)" },
  locationType: {
    type: "string",
    enum: ["Ward", "Bed", "ICU", "Cabin", "Floor", "OT", "CCU", "HDU", "NICU", "Emergency", "Other"],
  },
  locationDetail: { type: "string", maxLength: 100, description: "Room / bed / cabin number or label" },
  department: { type: "string", maxLength: 100 },
  diagnosis: { type: "string", maxLength: 500 },
  notes: { type: "string", maxLength: 1000 },

  doctorId: { ...objectIdSchema, description: "Assigned doctor ObjectId" },
  referrerId: { ...objectIdSchema, description: "Referrer ObjectId (optional)" },
};

// ─── Route Schemas ────────────────────────────────────────────────────────────

const getAllPatientsSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Get paginated indoor patients with optional search/filter",
    querystring: {
      type: "object",
      properties: {
        search: { type: "string", maxLength: 150 },
        status: { type: "string", enum: ["admitted", "released"] },
        page: { type: "integer", minimum: 1, default: 1 },
      },
    },
  },
};

const getPatientByIdSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Get a single indoor patient by ID",
    params: patientIdParamSchema,
  },
};

const createPatientSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Admit a new patient",
    body: {
      type: "object",
      required: ["name", "age", "gender", "admissionDate", "doctorId"],
      additionalProperties: false,
      properties: patientBodyProperties,
    },
  },
};

const updatePatientSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Update an existing indoor patient record",
    params: patientIdParamSchema,
    body: {
      type: "object",
      required: [],
      additionalProperties: false,
      minProperties: 1,
      properties: patientBodyProperties,
    },
  },
};

const transferPatientSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Transfer a patient to a new location and log history",
    params: patientIdParamSchema,
    body: {
      type: "object",
      required: ["toType"],
      additionalProperties: false,
      properties: {
        toType: {
          type: "string",
          enum: ["Ward", "Bed", "ICU", "Cabin", "Floor", "OT", "CCU", "HDU", "NICU", "Emergency", "Other"],
        },
        toDetail: { type: "string", maxLength: 100 },
        reason: { type: "string", maxLength: 300 },
      },
    },
  },
};

const releasePatientSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Release a patient (mark as released with timestamp)",
    params: patientIdParamSchema,
    body: {
      type: "object",
      additionalProperties: false,
      properties: {
        releaseDate: { type: "number", description: "Release timestamp (ms). Defaults to now." },
        releaseNotes: { type: "string", maxLength: 500 },
      },
    },
  },
};

const deletePatientSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Hard delete a patient record",
    params: patientIdParamSchema,
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

async function indoorPatientRoutes(fastify) {
  const collection = fastify.mongo.db.collection(collectionName);
  const doctorsCol = fastify.mongo.db.collection("doctors");
  const referrersCol = fastify.mongo.db.collection("referrers");
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);

  // ── GET /indoor-patients ──────────────────────────────────────────────────
  fastify.get("/indoor-patients", getAllPatientsSchema, async (req, reply) => {
    try {
      const { search, status, page = 1 } = req.query;
      const skip = (page - 1) * PAGE_SIZE;

      const query = { labId: labId(req) };
      if (status) query.status = status;

      if (search?.trim()) {
        const regex = { $regex: search.trim(), $options: "i" };
        query.$or = [
          { name: regex },
          { contactNumber: regex },
          { guardianName: regex },
          { guardianContact: regex },
          { locationType: regex },
          { locationDetail: regex },
          { department: regex },
          { diagnosis: regex },
          { nid: regex },
        ];
      }

      const [patients, total] = await Promise.all([
        collection.find(query).sort({ admissionDate: -1 }).skip(skip).limit(PAGE_SIZE).toArray(),
        collection.countDocuments(query),
      ]);

      // Batch-resolve doctor + referrer names
      const doctorIds = [
        ...new Set(
          patients
            .map((p) => p.doctorId)
            .filter(Boolean)
            .map(String),
        ),
      ];
      const referrerIds = [
        ...new Set(
          patients
            .map((p) => p.referrerId)
            .filter(Boolean)
            .map(String),
        ),
      ];

      const [doctors, referrers] = await Promise.all([
        doctorIds.length
          ? doctorsCol.find({ _id: { $in: doctorIds.map(toObjectId) } }, { projection: { name: 1 } }).toArray()
          : [],
        referrerIds.length
          ? referrersCol.find({ _id: { $in: referrerIds.map(toObjectId) } }, { projection: { name: 1 } }).toArray()
          : [],
      ]);

      const doctorMap = Object.fromEntries(doctors.map((d) => [String(d._id), d.name]));
      const referrerMap = Object.fromEntries(referrers.map((r) => [String(r._id), r.name]));

      const enriched = patients.map((p) => ({
        ...p,
        doctorName: p.doctorId ? (doctorMap[String(p.doctorId)] ?? null) : null,
        referrerName: p.referrerId ? (referrerMap[String(p.referrerId)] ?? null) : null,
      }));

      return reply.send({
        patients: enriched,
        total,
        page,
        totalPages: Math.ceil(total / PAGE_SIZE),
        pageSize: PAGE_SIZE,
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch indoor patients" });
    }
  });

  // ── GET /indoor-patient/:id ───────────────────────────────────────────────
  fastify.get("/indoor-patient/:id", getPatientByIdSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const patient = await collection.findOne({ _id, labId: labId(req) });
      if (!patient) return reply.code(404).send({ error: "Patient not found" });

      const [doctor, referrer] = await Promise.all([
        patient.doctorId
          ? doctorsCol.findOne(
              { _id: toObjectId(String(patient.doctorId)) },
              { projection: { name: 1, degree: 1, department: 1 } },
            )
          : null,
        patient.referrerId
          ? referrersCol.findOne({ _id: toObjectId(String(patient.referrerId)) }, { projection: { name: 1, type: 1 } })
          : null,
      ]);

      return { ...patient, doctor: doctor ?? null, referrer: referrer ?? null };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch patient" });
    }
  });

  // ── POST /indoor-patient/admit ────────────────────────────────────────────
  fastify.post("/indoor-patient/admit", createPatientSchema, async (req, reply) => {
    try {
      const {
        name,
        age,
        gender,
        bloodGroup,
        contactNumber,
        address,
        nid,
        guardianName,
        guardianRelation,
        guardianContact,
        admissionDate,
        locationType,
        locationDetail,
        department,
        diagnosis,
        notes,
        doctorId,
        referrerId,
      } = req.body;

      const doctorObjId = toObjectId(doctorId);
      if (!doctorObjId) return reply.code(400).send({ error: "Invalid doctor ID" });

      const doctorExists = await doctorsCol.findOne(
        { _id: doctorObjId, labId: labId(req) },
        { projection: { _id: 1 } },
      );
      if (!doctorExists) return reply.code(400).send({ error: "Doctor not found" });

      let referrerObjId = null;
      if (referrerId) {
        referrerObjId = toObjectId(referrerId);
        if (!referrerObjId) return reply.code(400).send({ error: "Invalid referrer ID" });
        const refExists = await referrersCol.findOne(
          { _id: referrerObjId, labId: labId(req) },
          { projection: { _id: 1 } },
        );
        if (!refExists) return reply.code(400).send({ error: "Referrer not found" });
      }

      const result = await collection.insertOne({
        labId: labId(req),
        status: "admitted",
        name,
        age,
        gender,
        bloodGroup: bloodGroup ?? "unknown",
        contactNumber: contactNumber ?? "",
        address: address ?? "",
        nid: nid ?? "",
        guardianName: guardianName ?? "",
        guardianRelation: guardianRelation ?? "",
        guardianContact: guardianContact ?? "",
        admissionDate,
        locationType: locationType ?? null,
        locationDetail: locationDetail ?? "",
        department: department ?? "",
        diagnosis: diagnosis ?? "",
        notes: notes ?? "",
        doctorId: doctorObjId,
        referrerId: referrerObjId,
        transferHistory: [],
        releaseDate: null,
        releaseNotes: "",
        created: { at: Date.now(), by: { id: req.user.id, name: req.user.name } },
      });

      return reply.code(201).send({ _id: result.insertedId });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to admit patient" });
    }
  });

  // ── PUT /indoor-patient/edit/:id ──────────────────────────────────────────
  fastify.put("/indoor-patient/edit/:id", updatePatientSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const body = { ...req.body };

      if (body.doctorId) {
        const doctorObjId = toObjectId(body.doctorId);
        if (!doctorObjId) return reply.code(400).send({ error: "Invalid doctor ID" });
        const exists = await doctorsCol.findOne({ _id: doctorObjId, labId: labId(req) }, { projection: { _id: 1 } });
        if (!exists) return reply.code(400).send({ error: "Doctor not found" });
        body.doctorId = doctorObjId;
      }

      if (body.referrerId) {
        const refObjId = toObjectId(body.referrerId);
        if (!refObjId) return reply.code(400).send({ error: "Invalid referrer ID" });
        const exists = await referrersCol.findOne({ _id: refObjId, labId: labId(req) }, { projection: { _id: 1 } });
        if (!exists) return reply.code(400).send({ error: "Referrer not found" });
        body.referrerId = refObjId;
      }

      const result = await collection.updateOne(
        { _id, labId: labId(req) },
        { $set: { ...body, updated: { at: Date.now(), by: { id: req.user.id, name: req.user.name } } } },
      );
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Patient not found" });

      return { message: "Patient updated successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update patient" });
    }
  });

  // ── PATCH /indoor-patient/:id/transfer ───────────────────────────────────
  fastify.patch("/indoor-patient/:id/transfer", transferPatientSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const patient = await collection.findOne(
        { _id, labId: labId(req) },
        { projection: { status: 1, locationType: 1, locationDetail: 1 } },
      );
      if (!patient) return reply.code(404).send({ error: "Patient not found" });
      if (patient.status === "released") return reply.code(400).send({ error: "Cannot transfer a released patient" });

      const { toType, toDetail = "", reason = "" } = req.body;

      const historyEntry = {
        fromType: patient.locationType ?? null,
        fromDetail: patient.locationDetail ?? "",
        toType,
        toDetail,
        reason,
        at: Date.now(),
        by: { id: req.user.id, name: req.user.name },
      };

      const result = await collection.updateOne(
        { _id, labId: labId(req) },
        {
          $set: {
            locationType: toType,
            locationDetail: toDetail,
            updated: { at: Date.now(), by: { id: req.user.id, name: req.user.name } },
          },
          $push: { transferHistory: historyEntry },
        },
      );
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Patient not found" });

      return { message: "Patient transferred successfully", locationType: toType, locationDetail: toDetail };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to transfer patient" });
    }
  });

  // ── PATCH /indoor-patient/:id/release ────────────────────────────────────
  fastify.patch("/indoor-patient/:id/release", releasePatientSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const patient = await collection.findOne({ _id, labId: labId(req) }, { projection: { status: 1 } });
      if (!patient) return reply.code(404).send({ error: "Patient not found" });
      if (patient.status === "released") return reply.code(400).send({ error: "Patient is already released" });

      const { releaseDate, releaseNotes } = req.body ?? {};

      const result = await collection.updateOne(
        { _id, labId: labId(req) },
        {
          $set: {
            status: "released",
            releaseDate: releaseDate ?? Date.now(),
            releaseNotes: releaseNotes ?? "",
            updated: { at: Date.now(), by: { id: req.user.id, name: req.user.name } },
          },
        },
      );
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Patient not found" });

      return { message: "Patient released successfully", _id: req.params.id };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to release patient" });
    }
  });

  // ── DELETE /indoor-patient/:id ────────────────────────────────────────────
  fastify.delete("/indoor-patient/:id", deletePatientSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const result = await collection.deleteOne({ _id, labId: labId(req) });
      if (result.deletedCount === 0) return reply.code(404).send({ error: "Patient not found" });

      return { message: "Patient record deleted successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to delete patient" });
    }
  });
}

export default indoorPatientRoutes;
