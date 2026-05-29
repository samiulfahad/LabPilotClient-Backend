/**
 * indoorPatients.routes.js
 * Fastify routes for Indoor Patient Admission Management
 *
 * Collection: indoorPatients
 *
 * Document shape:
 * {
 *   _id                : ObjectId,
 *   labId              : ObjectId,
 *   admissionId        : String,          // e.g. "IPD-20240601-0001"
 *   status             : "admitted" | "released",
 *
 *   patient: {
 *     name             : String,
 *     age              : Number,
 *     gender           : "male" | "female" | "other",
 *     bloodGroup       : String,          // "A+" | "A-" | "B+" | "B-" | "AB+" | "AB-" | "O+" | "O-"
 *     contactNumber    : String,
 *     address          : String,
 *     guardian: {
 *       name           : String,
 *       relation       : String,
 *       contactNumber  : String,
 *     },
 *   },
 *
 *   disease: {
 *     description      : String,          // brief description
 *     medicalHistory   : String,          // past medical history
 *   },
 *
 *   space: {
 *     spaceId          : ObjectId,
 *     spaceName        : String,
 *     bedNumber        : Number | null,   // null for single-bed
 *     chargePerDay     : Number,
 *   },
 *
 *   supervisorDoctor: {
 *     doctorId         : ObjectId,
 *     name             : String,
 *     degree           : String,
 *   },
 *   doctorHistory      : [{ doctorId, name, degree, changedAt, changedBy }],
 *
 *   referrer: {
 *     referrerId       : ObjectId | null,
 *     name             : String,
 *     type             : String,
 *   },
 *
 *   dealType           : "package" | "regular",
 *   packageDeal: {
 *     description      : String,
 *     totalAmount      : Number,
 *   } | null,
 *
 *   wardHistory        : [{ spaceId, spaceName, bedNumber, movedAt, movedBy, note }],
 *
 *   expenses           : [{ type, itemId, name, price, quantity, addedAt, addedBy }],
 *
 *   payments           : [{ amount, collectedBy: { id, name }, collectedAt, note }],
 *
 *   admittedAt         : Number,          // timestamp
 *   admittedBy         : { id, name },
 *   releasedAt         : Number | null,
 *   releasedBy         : { id, name } | null,
 *
 *   created            : { at: Number, by: { id, name } },
 *   updated            : { at: Number, by: { id, name } },
 * }
 */

import toObjectId from "../../utils/db.js";

const COLLECTION = "indoorPatients";
const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

// ─── Schema Fragments ─────────────────────────────────────────────────────────

const objectIdSchema = { type: "string", minLength: 24, maxLength: 24 };

const patientParamSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { ...objectIdSchema, description: "ObjectId of the indoor patient record" } },
};

const guardianSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", maxLength: 100 },
    relation: { type: "string", maxLength: 50 },
    contactNumber: { type: "string", maxLength: 15 },
  },
};

const patientInfoSchema = {
  type: "object",
  required: ["name", "age", "gender", "contactNumber"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
    age: { type: "integer", minimum: 0, maximum: 150 },
    gender: { type: "string", enum: ["male", "female", "other"] },
    bloodGroup: { type: "string", enum: BLOOD_GROUPS },
    contactNumber: { type: "string", minLength: 10, maxLength: 15 },
    address: { type: "string", maxLength: 500 },
    guardian: guardianSchema,
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const now = () => Date.now();
const by = (req) => ({ id: req.user.id, name: req.user.name });

// Generate human-readable admission ID: IPD-YYYYMMDD-NNNN
const generateAdmissionId = async (col, labId) => {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `IPD-${dateStr}-`;
  const lastDoc = await col
    .find({ labId, admissionId: { $regex: `^${prefix}` } })
    .sort({ admissionId: -1 })
    .limit(1)
    .toArray();

  let seq = 1;
  if (lastDoc.length > 0) {
    const lastSeq = parseInt(lastDoc[0].admissionId.split("-").pop(), 10);
    seq = lastSeq + 1;
  }
  return `${prefix}${String(seq).padStart(4, "0")}`;
};

// ─── Routes ───────────────────────────────────────────────────────────────────

async function indoorPatientRoutes(fastify) {
  const col = () => fastify.mongo.db.collection(COLLECTION);
  const spacesCol = () => fastify.mongo.db.collection("admissionSpaces");
  const doctorsCol = () => fastify.mongo.db.collection("doctors");
  const referrersCol = () => fastify.mongo.db.collection("referrers");
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);

  // ── GET /indoor-patients/required-data ──────────────────────────────────────
  // Fetches spaces, doctors, referrers needed to admit a patient
  fastify.get(
    "/indoor-patients/required-data",
    {
      schema: {
        tags: ["IndoorPatients"],
        summary: "Get spaces, doctors and referrers needed for patient admission",
      },
    },
    async (req, reply) => {
      try {
        const [spaces, doctors, referrers] = await Promise.all([
          spacesCol()
            .find({ labId: labId(req) })
            .sort({ name: 1 })
            .toArray(),
          doctorsCol()
            .find({ labId: labId(req) })
            .sort({ name: 1 })
            .toArray(),
          referrersCol()
            .find({ labId: labId(req), isActive: true })
            .sort({ name: 1 })
            .toArray(),
        ]);
        return reply.send({ spaces, doctors, referrers });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch required data" });
      }
    },
  );

  // ── GET /indoor-patients ─────────────────────────────────────────────────────
  fastify.get(
    "/indoor-patients",
    {
      schema: {
        tags: ["IndoorPatients"],
        summary: "Get list of indoor patients with optional filters",
        querystring: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["admitted", "released", "all"] },
            search: { type: "string", maxLength: 100 },
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const { status = "admitted", search = "", page = 1, limit = 20 } = req.query;
        const skip = (page - 1) * limit;

        const filter = { labId: labId(req) };
        if (status !== "all") filter.status = status;
        if (search.trim()) {
          filter.$or = [
            { "patient.name": { $regex: search.trim(), $options: "i" } },
            { "patient.contactNumber": { $regex: search.trim(), $options: "i" } },
            { admissionId: { $regex: search.trim(), $options: "i" } },
          ];
        }

        const [patients, total] = await Promise.all([
          col()
            .find(filter, {
              projection: {
                admissionId: 1,
                status: 1,
                patient: 1,
                "space.spaceName": 1,
                "space.bedNumber": 1,
                "supervisorDoctor.name": 1,
                admittedAt: 1,
                releasedAt: 1,
                dealType: 1,
                payments: 1,
                expenses: 1,
              },
            })
            .sort({ admittedAt: -1 })
            .skip(skip)
            .limit(limit)
            .toArray(),
          col().countDocuments(filter),
        ]);

        return reply.send({
          patients,
          total,
          page,
          totalPages: Math.ceil(total / limit),
        });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch indoor patients" });
      }
    },
  );

  // ── GET /indoor-patient/:id ──────────────────────────────────────────────────
  fastify.get(
    "/indoor-patient/:id",
    {
      schema: {
        tags: ["IndoorPatients"],
        summary: "Get full indoor patient record by ID",
        params: patientParamSchema,
      },
    },
    async (req, reply) => {
      try {
        const _id = toObjectId(req.params.id);
        if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

        const patient = await col().findOne({ _id, labId: labId(req) });
        if (!patient) return reply.code(404).send({ error: "Indoor patient not found" });
        return reply.send(patient);
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch indoor patient" });
      }
    },
  );

  // ── POST /indoor-patient/admit ───────────────────────────────────────────────
  fastify.post(
    "/indoor-patient/admit",
    {
      schema: {
        tags: ["IndoorPatients"],
        summary: "Admit a new indoor patient",
        body: {
          type: "object",
          required: ["patient", "spaceId", "doctorId", "dealType"],
          additionalProperties: false,
          properties: {
            patient: patientInfoSchema,
            spaceId: objectIdSchema,
            bedNumber: { type: ["integer", "null"] },
            doctorId: objectIdSchema,
            referrerId: { type: ["string", "null"], minLength: 24, maxLength: 24 },
            referrerName: { type: ["string", "null"], maxLength: 150 },
            referrerType: { type: ["string", "null"], maxLength: 50 },
            disease: {
              type: "object",
              additionalProperties: false,
              properties: {
                description: { type: "string", maxLength: 2000 },
                medicalHistory: { type: "string", maxLength: 3000 },
              },
            },
            dealType: { type: "string", enum: ["package", "regular"] },
            packageDeal: {
              type: "object",
              additionalProperties: false,
              properties: {
                description: { type: "string", maxLength: 500 },
                totalAmount: { type: "number", minimum: 0 },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const {
          patient,
          spaceId,
          bedNumber,
          doctorId,
          referrerId,
          referrerName,
          referrerType,
          disease,
          dealType,
          packageDeal,
        } = req.body;

        // Fetch space
        const space = await spacesCol().findOne({
          _id: toObjectId(spaceId),
          labId: labId(req),
        });
        if (!space) return reply.code(404).send({ error: "Space not found" });

        // Validate bed availability for multi-bed
        if (space.multiBed) {
          if (bedNumber == null) return reply.code(400).send({ error: "bedNumber is required for multi-bed spaces" });
          const { totalNumberOfBed, bedStartingNumber, booked = [], reserved = [] } = space.multiBedConf;
          if (bedNumber < bedStartingNumber || bedNumber >= bedStartingNumber + totalNumberOfBed) {
            return reply.code(400).send({ error: "Bed number out of range" });
          }
          if (booked.includes(bedNumber)) return reply.code(409).send({ error: "Bed is already occupied" });
          if (reserved.some((r) => r.bedNumber === bedNumber)) {
            return reply.code(409).send({ error: "Bed is already reserved" });
          }
        } else {
          if (space.reserved) return reply.code(409).send({ error: "Space is already reserved" });
        }

        // Fetch doctor
        const doctor = await doctorsCol().findOne({
          _id: toObjectId(doctorId),
          labId: labId(req),
        });
        if (!doctor) return reply.code(404).send({ error: "Doctor not found" });

        // Fetch referrer if provided
        let resolvedReferrer = { referrerId: null, name: referrerName ?? null, type: referrerType ?? null };
        if (referrerId) {
          const ref = await referrersCol().findOne({ _id: toObjectId(referrerId), labId: labId(req) });
          if (ref) {
            resolvedReferrer = {
              referrerId: toObjectId(referrerId),
              name: ref.name,
              type: ref.type,
            };
          }
        }

        // Package deal validation
        if (dealType === "package" && !packageDeal) {
          return reply.code(400).send({ error: "packageDeal is required when dealType is package" });
        }

        const admissionId = await generateAdmissionId(col(), labId(req));

        const doc = {
          labId: labId(req),
          admissionId,
          status: "admitted",

          patient: {
            name: patient.name.trim(),
            age: patient.age,
            gender: patient.gender,
            bloodGroup: patient.bloodGroup ?? null,
            contactNumber: patient.contactNumber.trim(),
            address: patient.address?.trim() ?? "",
            guardian: {
              name: patient.guardian?.name?.trim() ?? "",
              relation: patient.guardian?.relation?.trim() ?? "",
              contactNumber: patient.guardian?.contactNumber?.trim() ?? "",
            },
          },

          disease: {
            description: disease?.description?.trim() ?? "",
            medicalHistory: disease?.medicalHistory?.trim() ?? "",
          },

          space: {
            spaceId: toObjectId(spaceId),
            spaceName: space.name,
            bedNumber: space.multiBed ? bedNumber : null,
            chargePerDay: space.chargePerDay,
          },

          supervisorDoctor: {
            doctorId: toObjectId(doctorId),
            name: doctor.name,
            degree: doctor.degree ?? "",
          },
          doctorHistory: [],

          referrer: resolvedReferrer,

          dealType,
          packageDeal: dealType === "package" ? packageDeal : null,

          wardHistory: [],
          expenses: [],
          payments: [],

          admittedAt: now(),
          admittedBy: by(req),
          releasedAt: null,
          releasedBy: null,

          created: { at: now(), by: by(req) },
        };

        // Mark space/bed as booked
        if (space.multiBed) {
          await spacesCol().updateOne(
            { _id: toObjectId(spaceId), labId: labId(req) },
            {
              $push: { "multiBedConf.booked": bedNumber },
              $set: { updated: { at: now(), by: by(req) } },
            },
          );
        } else {
          await spacesCol().updateOne(
            { _id: toObjectId(spaceId), labId: labId(req) },
            { $set: { reserved: true, reservedNote: `IPD: ${admissionId}`, updated: { at: now(), by: by(req) } } },
          );
        }

        const result = await col().insertOne(doc);
        return reply.code(201).send({ _id: result.insertedId, admissionId });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to admit patient" });
      }
    },
  );

  // ── PATCH /indoor-patient/:id/patient-info ───────────────────────────────────
  fastify.patch(
    "/indoor-patient/:id/patient-info",
    {
      schema: {
        tags: ["IndoorPatients"],
        summary: "Update patient basic info",
        params: patientParamSchema,
        body: {
          type: "object",
          required: ["patient"],
          additionalProperties: false,
          properties: { patient: patientInfoSchema },
        },
      },
    },
    async (req, reply) => {
      try {
        const _id = toObjectId(req.params.id);
        if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

        const { patient } = req.body;

        const result = await col().updateOne(
          { _id, labId: labId(req) },
          {
            $set: {
              "patient.name": patient.name.trim(),
              "patient.age": patient.age,
              "patient.gender": patient.gender,
              "patient.bloodGroup": patient.bloodGroup ?? null,
              "patient.contactNumber": patient.contactNumber.trim(),
              "patient.address": patient.address?.trim() ?? "",
              "patient.guardian": {
                name: patient.guardian?.name?.trim() ?? "",
                relation: patient.guardian?.relation?.trim() ?? "",
                contactNumber: patient.guardian?.contactNumber?.trim() ?? "",
              },
              updated: { at: now(), by: by(req) },
            },
          },
        );
        if (result.matchedCount === 0) return reply.code(404).send({ error: "Patient not found" });
        return reply.send({ success: true });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to update patient info" });
      }
    },
  );

  // ── PATCH /indoor-patient/:id/transfer-ward ──────────────────────────────────
  fastify.patch(
    "/indoor-patient/:id/transfer-ward",
    {
      schema: {
        tags: ["IndoorPatients"],
        summary: "Transfer patient to another ward/bed",
        params: patientParamSchema,
        body: {
          type: "object",
          required: ["spaceId"],
          additionalProperties: false,
          properties: {
            spaceId: objectIdSchema,
            bedNumber: { type: ["integer", "null"] },
            note: { type: "string", maxLength: 500 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const _id = toObjectId(req.params.id);
        if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

        const admission = await col().findOne({ _id, labId: labId(req) });
        if (!admission) return reply.code(404).send({ error: "Patient not found" });
        if (admission.status !== "admitted")
          return reply.code(400).send({ error: "Patient is not currently admitted" });

        const { spaceId, bedNumber, note } = req.body;

        // Fetch new space
        const newSpace = await spacesCol().findOne({ _id: toObjectId(spaceId), labId: labId(req) });
        if (!newSpace) return reply.code(404).send({ error: "Target space not found" });

        // Validate new bed
        if (newSpace.multiBed) {
          if (bedNumber == null) return reply.code(400).send({ error: "bedNumber required for multi-bed space" });
          const { totalNumberOfBed, bedStartingNumber, booked = [] } = newSpace.multiBedConf;
          if (bedNumber < bedStartingNumber || bedNumber >= bedStartingNumber + totalNumberOfBed) {
            return reply.code(400).send({ error: "Bed number out of range" });
          }
          if (booked.includes(bedNumber)) return reply.code(409).send({ error: "Bed is already occupied" });
        } else {
          if (newSpace.reserved) return reply.code(409).send({ error: "Target space is already occupied" });
        }

        const oldSpace = admission.space;

        // Release old space/bed
        if (oldSpace.bedNumber != null) {
          await spacesCol().updateOne(
            { _id: oldSpace.spaceId, labId: labId(req) },
            {
              $pull: { "multiBedConf.booked": oldSpace.bedNumber },
              $set: { updated: { at: now(), by: by(req) } },
            },
          );
        } else {
          await spacesCol().updateOne(
            { _id: oldSpace.spaceId, labId: labId(req) },
            { $set: { reserved: false, reservedNote: "", updated: { at: now(), by: by(req) } } },
          );
        }

        // Book new space/bed
        if (newSpace.multiBed) {
          await spacesCol().updateOne(
            { _id: toObjectId(spaceId), labId: labId(req) },
            {
              $push: { "multiBedConf.booked": bedNumber },
              $set: { updated: { at: now(), by: by(req) } },
            },
          );
        } else {
          await spacesCol().updateOne(
            { _id: toObjectId(spaceId), labId: labId(req) },
            {
              $set: {
                reserved: true,
                reservedNote: `IPD: ${admission.admissionId}`,
                updated: { at: now(), by: by(req) },
              },
            },
          );
        }

        // Update patient record
        await col().updateOne(
          { _id, labId: labId(req) },
          {
            $set: {
              space: {
                spaceId: toObjectId(spaceId),
                spaceName: newSpace.name,
                bedNumber: newSpace.multiBed ? bedNumber : null,
                chargePerDay: newSpace.chargePerDay,
              },
              updated: { at: now(), by: by(req) },
            },
            $push: {
              wardHistory: {
                fromSpaceId: oldSpace.spaceId,
                fromSpaceName: oldSpace.spaceName,
                fromBedNumber: oldSpace.bedNumber,
                toSpaceId: toObjectId(spaceId),
                toSpaceName: newSpace.name,
                toBedNumber: newSpace.multiBed ? bedNumber : null,
                movedAt: now(),
                movedBy: by(req),
                note: note ?? "",
              },
            },
          },
        );

        return reply.send({ success: true });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to transfer patient" });
      }
    },
  );

  // ── PATCH /indoor-patient/:id/change-doctor ──────────────────────────────────
  fastify.patch(
    "/indoor-patient/:id/change-doctor",
    {
      schema: {
        tags: ["IndoorPatients"],
        summary: "Change the supervisor doctor for a patient",
        params: patientParamSchema,
        body: {
          type: "object",
          required: ["doctorId"],
          additionalProperties: false,
          properties: {
            doctorId: objectIdSchema,
            note: { type: "string", maxLength: 500 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const _id = toObjectId(req.params.id);
        if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

        const { doctorId, note } = req.body;

        const [admission, doctor] = await Promise.all([
          col().findOne({ _id, labId: labId(req) }),
          doctorsCol().findOne({ _id: toObjectId(doctorId), labId: labId(req) }),
        ]);

        if (!admission) return reply.code(404).send({ error: "Patient not found" });
        if (!doctor) return reply.code(404).send({ error: "Doctor not found" });

        await col().updateOne(
          { _id, labId: labId(req) },
          {
            $set: {
              supervisorDoctor: {
                doctorId: toObjectId(doctorId),
                name: doctor.name,
                degree: doctor.degree ?? "",
              },
              updated: { at: now(), by: by(req) },
            },
            $push: {
              doctorHistory: {
                previousDoctorId: admission.supervisorDoctor.doctorId,
                previousDoctorName: admission.supervisorDoctor.name,
                newDoctorId: toObjectId(doctorId),
                newDoctorName: doctor.name,
                changedAt: now(),
                changedBy: by(req),
                note: note ?? "",
              },
            },
          },
        );

        return reply.send({ success: true });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to change doctor" });
      }
    },
  );

  // ── POST /indoor-patient/:id/expense ────────────────────────────────────────
  fastify.post(
    "/indoor-patient/:id/expense",
    {
      schema: {
        tags: ["IndoorPatients"],
        summary: "Add an expense item (medicine, test, service, etc.)",
        params: patientParamSchema,
        body: {
          type: "object",
          required: ["type", "name", "price", "quantity"],
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["medicine", "test", "service", "other"] },
            itemId: { type: ["string", "null"], minLength: 24, maxLength: 24 },
            name: { type: "string", minLength: 1, maxLength: 200 },
            price: { type: "number", minimum: 0 },
            quantity: { type: "integer", minimum: 1, default: 1 },
            note: { type: "string", maxLength: 300 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const _id = toObjectId(req.params.id);
        if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

        const { type, itemId, name, price, quantity, note } = req.body;

        const result = await col().updateOne(
          { _id, labId: labId(req) },
          {
            $push: {
              expenses: {
                type,
                itemId: itemId ? toObjectId(itemId) : null,
                name: name.trim(),
                price,
                quantity,
                total: price * quantity,
                note: note ?? "",
                addedAt: now(),
                addedBy: by(req),
              },
            },
            $set: { updated: { at: now(), by: by(req) } },
          },
        );

        if (result.matchedCount === 0) return reply.code(404).send({ error: "Patient not found" });
        return reply.code(201).send({ success: true });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to add expense" });
      }
    },
  );

  // ── POST /indoor-patient/:id/payment ────────────────────────────────────────
  fastify.post(
    "/indoor-patient/:id/payment",
    {
      schema: {
        tags: ["IndoorPatients"],
        summary: "Record a payment collection",
        params: patientParamSchema,
        body: {
          type: "object",
          required: ["amount"],
          additionalProperties: false,
          properties: {
            amount: { type: "number", minimum: 0.01 },
            note: { type: "string", maxLength: 300 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const _id = toObjectId(req.params.id);
        if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

        const { amount, note } = req.body;

        const result = await col().updateOne(
          { _id, labId: labId(req) },
          {
            $push: {
              payments: {
                amount,
                collectedBy: by(req),
                collectedAt: now(),
                note: note ?? "",
              },
            },
            $set: { updated: { at: now(), by: by(req) } },
          },
        );

        if (result.matchedCount === 0) return reply.code(404).send({ error: "Patient not found" });
        return reply.code(201).send({ success: true });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to record payment" });
      }
    },
  );

  // ── PATCH /indoor-patient/:id/release ────────────────────────────────────────
  fastify.patch(
    "/indoor-patient/:id/release",
    {
      schema: {
        tags: ["IndoorPatients"],
        summary: "Release / discharge an admitted patient",
        params: patientParamSchema,
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            note: { type: "string", maxLength: 500 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const _id = toObjectId(req.params.id);
        if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

        const admission = await col().findOne({ _id, labId: labId(req) });
        if (!admission) return reply.code(404).send({ error: "Patient not found" });
        if (admission.status !== "admitted") return reply.code(400).send({ error: "Patient is already released" });

        // Free up the space/bed
        if (admission.space.bedNumber != null) {
          await spacesCol().updateOne(
            { _id: admission.space.spaceId, labId: labId(req) },
            {
              $pull: { "multiBedConf.booked": admission.space.bedNumber },
              $set: { updated: { at: now(), by: by(req) } },
            },
          );
        } else {
          await spacesCol().updateOne(
            { _id: admission.space.spaceId, labId: labId(req) },
            { $set: { reserved: false, reservedNote: "", updated: { at: now(), by: by(req) } } },
          );
        }

        await col().updateOne(
          { _id, labId: labId(req) },
          {
            $set: {
              status: "released",
              releasedAt: now(),
              releasedBy: by(req),
              updated: { at: now(), by: by(req) },
            },
          },
        );

        return reply.send({ success: true });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to release patient" });
      }
    },
  );
}

export default indoorPatientRoutes;
