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
 *   admissionId        : String,          // e.g. "IP482XK" (IP + 3 digits[1-9] + 2 letters[no O])
 *   status             : "admitted" | "released",
 *
 *   patient: {
 *     name, age, gender, bloodGroup, contactNumber, address,
 *     guardian: { name, relation, contactNumber },
 *   },
 *
 *   disease: { description, medicalHistory },
 *
 *   space: {
 *     spaceId, spaceName, bedNumber, chargePerDay,
 *     fromDate : Number,
 *   },
 *
 *   supervisorDoctor : { doctorId, name, degree },
 *   doctorHistory    : [...],
 *   referrer         : { referrerId, name, type },
 *
 *   dealType    : "package" | "regular",
 *   packageDeal : { description, totalAmount } | null,
 *
 *   wardHistory: [{
 *     fromSpaceId, fromSpaceName, fromBedNumber,
 *     toSpaceId, toSpaceName, toBedNumber,
 *     chargePerDay,
 *     fromDate, toDate,
 *     movedAt, movedBy, note,
 *   }],
 *
 *   expenses: [{ type, itemId, name, price, quantity, total, note, addedAt, addedBy }],
 *
 *   reports: [
 *     // online test (schemaId present) — full report tracking
 *     { testId, name, schemaId, report: {}, isCompleted, completedAt, updatedAt, addedAt, addedBy }
 *
 *     // offline test (no schemaId) — visibility only
 *     { testId, name, schemaId: null, addedAt, addedBy }
 *   ],
 *
 *   bedCharges: [{
 *     date      : String,   // "YYYY-MM-DD" BST
 *     spaceName : String,
 *     bedNumber : Number | null,
 *     amount    : Number,
 *     waiver    : { amount: Number, note: String } | null,
 *     net       : Number,
 *     addedAt   : Number,
 *     addedBy   : { id, name },
 *   }],
 *
 *   waivers: [{
 *     type      : "bed-charge" | "bed-charge-bulk",
 *     refDate   : String | null,
 *     refDates  : [String] | null,
 *     amount    : Number,
 *     note      : String,
 *     appliedAt : Number,
 *     appliedBy : { id, name },
 *   }],
 *
 *   payments : [{ amount, collectedBy: { id, name }, collectedAt, note }],
 *
 *   admittedAt, admittedBy, releasedAt, releasedBy,
 *   created: { at, by },
 *   updated: { at, by },
 * }
 */

import toObjectId from "../../utils/db.js";

const COLLECTION = "indoorPatients";
const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

// ─── Schema Fragments ─────────────────────────────────────────────────────────

const objectIdSchema = { type: "string", minLength: 24, maxLength: 24 };
const nullableObjectIdSchema = { type: ["string", "null"], minLength: 24, maxLength: 24 };

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

const diseaseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: "string", maxLength: 2000 },
    medicalHistory: { type: "string", maxLength: 3000 },
  },
};

// ─── Updated Discount Schema ──────────────────────────────────────────────────
const addDiscountSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Add a discount to a specific expense category or grand total",
    params: { type: "object", required: ["id"], properties: { id: objectIdSchema } },
    body: {
      type: "object",
      required: ["category", "amount", "providedBy"],
      additionalProperties: false,
      properties: {
        category: {
          type: "string",
          enum: ["test", "medicine", "bed-charge", "product", "other", "grand-total"],
        },
        amount: { type: "number", minimum: 0.01 },
        providedBy: { type: "string", enum: ["hospital", "doctor", "referrer"] },
        note: { type: "string", maxLength: 300 },
      },
    },
  },
};
const packageDealSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: "string", maxLength: 500 },
    totalAmount: { type: "number", minimum: 0 },
  },
};

// ─── Route Schemas ────────────────────────────────────────────────────────────

const getRequiredDataSchema = {
  schema: { tags: ["IndoorPatients"], summary: "Get spaces, doctors and referrers needed for patient admission" },
};

const listPatientsSchema = {
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
};

const getPatientSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Get full indoor patient record by ID",
    params: {
      type: "object",
      required: ["id"],
      properties: { id: { ...objectIdSchema, description: "ObjectId of the indoor patient record" } },
    },
  },
};

const admitPatientSchema = {
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
        referrerId: nullableObjectIdSchema,
        referrerName: { type: ["string", "null"], maxLength: 150 },
        referrerType: { type: ["string", "null"], maxLength: 50 },
        disease: diseaseSchema,
        dealType: { type: "string", enum: ["package", "regular"] },
        packageDeal: packageDealSchema,
      },
    },
  },
};

const updatePatientInfoSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Update patient basic info",
    params: { type: "object", required: ["id"], properties: { id: objectIdSchema } },
    body: {
      type: "object",
      required: ["patient"],
      additionalProperties: false,
      properties: { patient: patientInfoSchema },
    },
  },
};

const transferWardSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Transfer patient to another ward/bed",
    params: { type: "object", required: ["id"], properties: { id: objectIdSchema } },
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
};

const changeDoctorSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Change the supervisor doctor for a patient",
    params: { type: "object", required: ["id"], properties: { id: objectIdSchema } },
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
};

const addExpenseSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Add an expense item (medicine, test, service, etc.)",
    params: { type: "object", required: ["id"], properties: { id: objectIdSchema } },
    body: {
      type: "object",
      required: ["type", "name", "price", "quantity"],
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: ["medicine", "product", "test", "service", "other"] },
        itemId: nullableObjectIdSchema,
        name: { type: "string", minLength: 1, maxLength: 200 },
        price: { type: "number", minimum: 0 },
        quantity: { type: "integer", minimum: 1, default: 1 },
        note: { type: "string", maxLength: 300 },
        // Only relevant when type === "test". If present, the test is online.
        schemaId: nullableObjectIdSchema,
      },
    },
  },
};

const addPaymentSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Record a payment collection",
    params: { type: "object", required: ["id"], properties: { id: objectIdSchema } },
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
};

const releasePatientSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Release / discharge an admitted patient",
    params: { type: "object", required: ["id"], properties: { id: objectIdSchema } },
    body: {
      type: "object",
      additionalProperties: false,
      properties: { note: { type: "string", maxLength: 500 } },
    },
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const now = () => Date.now();
const by = (req) => ({ id: req.user.id, name: req.user.name });

// Generate human-readable admission ID: IPnnnLL (e.g. IP482XK)
// 3 digits (1-9, never 0) + 2 uppercase letters (excluding O)
const generateAdmissionId = async (col, labId) => {
  const DIGIT_CHARS = "123456789";
  const LETTER_CHARS = "ABCDEFGHIJKLMNPQRSTUVWXYZ"; // O excluded
  const maxAttempts = 10;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let candidate = "IP";
    for (let i = 0; i < 3; i++) candidate += DIGIT_CHARS[Math.floor(Math.random() * DIGIT_CHARS.length)];
    for (let i = 0; i < 2; i++) candidate += LETTER_CHARS[Math.floor(Math.random() * LETTER_CHARS.length)];

    const exists = await col.findOne({ labId, admissionId: candidate }, { projection: { _id: 1 } });
    if (!exists) return candidate;
  }

  throw new Error("Failed to generate unique admission ID after multiple attempts");
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
  fastify.get("/indoor-patients/required-data", getRequiredDataSchema, async (req, reply) => {
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
  });

  // ── GET /indoor-patients ─────────────────────────────────────────────────────
  fastify.get("/indoor-patients", listPatientsSchema, async (req, reply) => {
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
              "space.fromDate": 1,
              "supervisorDoctor.name": 1,
              admittedAt: 1,
              releasedAt: 1,
            },
          })
          .sort({ admittedAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        col().countDocuments(filter),
      ]);

      return reply.send({ patients, total, page, totalPages: Math.ceil(total / limit) });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch indoor patients" });
    }
  });

  // ── POST /indoor-patient/:id/discount ────────────────────────────────────────
  fastify.post("/indoor-patient/:id/discount", addDiscountSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });
      const { category, amount, providedBy, note } = req.body;
      const admission = await col().findOne({ _id, labId: labId(req) });
      if (!admission) return reply.code(404).send({ error: "Patient not found" });

      const expenses = admission.expenses ?? [];

      // ── Compute category gross total ─────────────────────────────────────────
      let categoryTotal = 0;

      if (category === "grand-total") {
        // Grand-total discount: cap against the entire bill (expenses + bed charges)
        const expenseTotal = expenses.reduce((s, e) => s + (e.total ?? e.price * e.quantity), 0);

        // Bed charge accrual (server-side approximate; mirrors frontend calcBedAccrual)
        let bedTotal = 0;
        if (admission.dealType === "regular") {
          const tsBst = (ts) => new Date(ts + 6 * 3600 * 1000).toISOString().slice(0, 10);
          const startStr = tsBst(admission.admittedAt);
          const endStr = admission.releasedAt ? tsBst(admission.releasedAt) : tsBst(Date.now());
          const startD = new Date(startStr + "T00:00:00Z");
          const endD = new Date(endStr + "T00:00:00Z");
          const cur = new Date(startD);
          while (cur <= endD) {
            const d = cur.toISOString().slice(0, 10);
            let daily = admission.space.chargePerDay;
            for (const h of admission.wardHistory ?? []) {
              if (!h.fromDate || !h.toDate) continue;
              const from = tsBst(h.fromDate);
              const to = tsBst(h.toDate);
              if (d >= from && d < to) {
                daily = h.chargePerDay ?? admission.space.chargePerDay;
                break;
              }
            }
            bedTotal += daily;
            cur.setUTCDate(cur.getUTCDate() + 1);
          }
        }

        const packageTotal = admission.dealType === "package" ? (admission.packageDeal?.totalAmount ?? 0) : 0;
        categoryTotal = admission.dealType === "package" ? packageTotal : expenseTotal + bedTotal;
      } else if (category === "bed-charge") {
        // Allow any reasonable amount; frontend already enforces the cap
        categoryTotal = Infinity;
      } else {
        const typeMap = {
          test: ["test"],
          medicine: ["medicine"],
          product: ["product"],
          other: ["service", "other"],
        };
        const matchTypes = typeMap[category] ?? [category];
        categoryTotal = expenses
          .filter((e) => matchTypes.includes(e.type))
          .reduce((s, e) => s + (e.total ?? e.price * e.quantity), 0);
      }

      // ── Check existing discounts for this category ───────────────────────────
      const existingDiscount = (admission.discounts ?? [])
        .filter((d) => d.category === category)
        .reduce((s, d) => s + d.amount, 0);

      if (categoryTotal !== Infinity && existingDiscount + amount > categoryTotal) {
        return reply.code(400).send({
          error: `Total discount for "${category}" (${existingDiscount + amount}) exceeds category total (${categoryTotal})`,
        });
      }

      const appliedAt = Date.now();
      const result = await col().updateOne(
        { _id, labId: labId(req) },
        {
          $push: {
            discounts: {
              category,
              amount,
              providedBy,
              note: note ?? "",
              appliedAt,
              appliedBy: by(req),
            },
          },
          $set: { updated: { at: appliedAt, by: by(req) } },
        },
      );

      if (result.matchedCount === 0) return reply.code(404).send({ error: "Patient not found" });
      return reply.code(201).send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to apply discount" });
    }
  });

  // ── GET /indoor-patient/:id ──────────────────────────────────────────────────
  fastify.get("/indoor-patient/:id", getPatientSchema, async (req, reply) => {
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
  });

  // ── GET /indoor-patient/by-admission-id/:admissionId ────────────────────────
  fastify.get(
    "/indoor-patient/by-admission-id/:admissionId",
    {
      schema: {
        tags: ["IndoorPatients"],
        summary: "Get indoor patient by human-readable admission ID — for report lookup",
        params: {
          type: "object",
          required: ["admissionId"],
          properties: {
            admissionId: {
              type: "string",
              pattern: "^[Ii][Pp][1-9]{3}[A-NP-Za-np-z]{2}$",
              minLength: 7,
              maxLength: 7,
            },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const patient = await col().findOne(
          { admissionId: req.params.admissionId.toUpperCase(), labId: labId(req) },
          {
            projection: {
              admissionId: 1,
              status: 1,
              patient: 1,
              reports: 1,
            },
          },
        );
        if (!patient) return reply.code(404).send({ error: "Indoor patient not found" });
        return reply.send(patient);
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch indoor patient" });
      }
    },
  );

  // ── POST /indoor-patient/admit ───────────────────────────────────────────────
  fastify.post("/indoor-patient/admit", admitPatientSchema, async (req, reply) => {
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

      const space = await spacesCol().findOne({ _id: toObjectId(spaceId), labId: labId(req) });
      if (!space) return reply.code(404).send({ error: "Space not found" });

      if (space.multiBed) {
        if (bedNumber == null) return reply.code(400).send({ error: "bedNumber is required for multi-bed spaces" });
        const { totalNumberOfBed, bedStartingNumber, booked = [], reserved = [] } = space.multiBedConf;
        if (bedNumber < bedStartingNumber || bedNumber >= bedStartingNumber + totalNumberOfBed)
          return reply.code(400).send({ error: "Bed number out of range" });
        if (booked.includes(bedNumber)) return reply.code(409).send({ error: "Bed is already occupied" });
        if (reserved.some((r) => r.bedNumber === bedNumber))
          return reply.code(409).send({ error: "Bed is already reserved" });
      } else {
        if (space.reserved) return reply.code(409).send({ error: "Space is already reserved" });
      }

      const doctor = await doctorsCol().findOne({ _id: toObjectId(doctorId), labId: labId(req) });
      if (!doctor) return reply.code(404).send({ error: "Doctor not found" });

      let resolvedReferrer = { referrerId: null, name: referrerName ?? null, type: referrerType ?? null };
      if (referrerId) {
        const ref = await referrersCol().findOne({ _id: toObjectId(referrerId), labId: labId(req) });
        if (ref) resolvedReferrer = { referrerId: toObjectId(referrerId), name: ref.name, type: ref.type };
      }

      if (dealType === "package" && !packageDeal)
        return reply.code(400).send({ error: "packageDeal is required when dealType is package" });

      const admissionId = await generateAdmissionId(col(), labId(req));
      const admittedAt = now();

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
          fromDate: admittedAt,
        },
        supervisorDoctor: { doctorId: toObjectId(doctorId), name: doctor.name, degree: doctor.degree ?? "" },
        doctorHistory: [],
        referrer: resolvedReferrer,
        dealType,
        packageDeal: dealType === "package" ? packageDeal : null,
        wardHistory: [],
        expenses: [],
        reports: [],
        bedCharges: [],
        waivers: [],
        payments: [],
        admittedAt,
        admittedBy: by(req),
        releasedAt: null,
        releasedBy: null,
        created: { at: admittedAt, by: by(req) },
      };

      if (space.multiBed) {
        await spacesCol().updateOne(
          { _id: toObjectId(spaceId), labId: labId(req) },
          { $push: { "multiBedConf.booked": bedNumber }, $set: { updated: { at: admittedAt, by: by(req) } } },
        );
      } else {
        await spacesCol().updateOne(
          { _id: toObjectId(spaceId), labId: labId(req) },
          { $set: { reserved: true, reservedNote: `IPD: ${admissionId}`, updated: { at: admittedAt, by: by(req) } } },
        );
      }

      const result = await col().insertOne(doc);
      return reply.code(201).send({ _id: result.insertedId, admissionId });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to admit patient" });
    }
  });

  // ── PATCH /indoor-patient/:id/patient-info ───────────────────────────────────
  fastify.patch("/indoor-patient/:id/patient-info", updatePatientInfoSchema, async (req, reply) => {
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
  });

  // ── PATCH /indoor-patient/:id/transfer-ward ──────────────────────────────────
  fastify.patch("/indoor-patient/:id/transfer-ward", transferWardSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const admission = await col().findOne({ _id, labId: labId(req) });
      if (!admission) return reply.code(404).send({ error: "Patient not found" });
      if (admission.status !== "admitted") return reply.code(400).send({ error: "Patient is not currently admitted" });

      const { spaceId, bedNumber, note } = req.body;

      // Guard: prevent "transferring" to the cabin the patient is already in
      if (admission.space?.spaceId?.toString() === toObjectId(spaceId)?.toString())
        return reply.code(400).send({ error: "Patient is already admitted in this cabin" });

      const newSpace = await spacesCol().findOne({ _id: toObjectId(spaceId), labId: labId(req) });
      if (!newSpace) return reply.code(404).send({ error: "Target space not found" });

      if (newSpace.multiBed) {
        if (bedNumber == null) return reply.code(400).send({ error: "bedNumber required for multi-bed space" });
        const { totalNumberOfBed, bedStartingNumber, booked = [] } = newSpace.multiBedConf;
        if (bedNumber < bedStartingNumber || bedNumber >= bedStartingNumber + totalNumberOfBed)
          return reply.code(400).send({ error: "Bed number out of range" });
        if (booked.includes(bedNumber)) return reply.code(409).send({ error: "Bed is already occupied" });
      } else {
        if (newSpace.reserved) return reply.code(409).send({ error: "Target space is already occupied" });
      }

      const oldSpace = admission.space;
      const transferTime = now();

      if (oldSpace.bedNumber != null) {
        await spacesCol().updateOne(
          { _id: oldSpace.spaceId, labId: labId(req) },
          {
            $pull: { "multiBedConf.booked": oldSpace.bedNumber },
            $set: { updated: { at: transferTime, by: by(req) } },
          },
        );
      } else {
        await spacesCol().updateOne(
          { _id: oldSpace.spaceId, labId: labId(req) },
          { $set: { reserved: false, reservedNote: "", updated: { at: transferTime, by: by(req) } } },
        );
      }

      if (newSpace.multiBed) {
        await spacesCol().updateOne(
          { _id: toObjectId(spaceId), labId: labId(req) },
          { $push: { "multiBedConf.booked": bedNumber }, $set: { updated: { at: transferTime, by: by(req) } } },
        );
      } else {
        await spacesCol().updateOne(
          { _id: toObjectId(spaceId), labId: labId(req) },
          {
            $set: {
              reserved: true,
              reservedNote: `IPD: ${admission.admissionId}`,
              updated: { at: transferTime, by: by(req) },
            },
          },
        );
      }

      await col().updateOne(
        { _id, labId: labId(req) },
        {
          $set: {
            space: {
              spaceId: toObjectId(spaceId),
              spaceName: newSpace.name,
              bedNumber: newSpace.multiBed ? bedNumber : null,
              chargePerDay: newSpace.chargePerDay,
              fromDate: transferTime,
            },
            updated: { at: transferTime, by: by(req) },
          },
          $push: {
            wardHistory: {
              fromSpaceId: oldSpace.spaceId,
              fromSpaceName: oldSpace.spaceName,
              fromBedNumber: oldSpace.bedNumber,
              toSpaceId: toObjectId(spaceId),
              toSpaceName: newSpace.name,
              toBedNumber: newSpace.multiBed ? bedNumber : null,
              chargePerDay: oldSpace.chargePerDay,
              fromDate: oldSpace.fromDate ?? admission.admittedAt,
              toDate: transferTime,
              movedAt: transferTime,
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
  });

  // ── PATCH /indoor-patient/:id/change-doctor ──────────────────────────────────
  fastify.patch("/indoor-patient/:id/change-doctor", changeDoctorSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });
      const { doctorId, note } = req.body;

      const admission = await col().findOne({ _id, labId: labId(req) });
      if (!admission) return reply.code(404).send({ error: "Patient not found" });

      // Guard: prevent "changing" to the doctor already supervising this patient
      if (admission.supervisorDoctor?.doctorId?.toString() === toObjectId(doctorId)?.toString())
        return reply.code(400).send({ error: "Patient is already under this doctor" });

      const doctor = await doctorsCol().findOne({ _id: toObjectId(doctorId), labId: labId(req) });
      if (!doctor) return reply.code(404).send({ error: "Doctor not found" });

      const changedAt = now();
      await col().updateOne(
        { _id, labId: labId(req) },
        {
          $set: {
            supervisorDoctor: { doctorId: toObjectId(doctorId), name: doctor.name, degree: doctor.degree ?? "" },
            updated: { at: changedAt, by: by(req) },
          },
          $push: {
            doctorHistory: {
              previousDoctorId: admission.supervisorDoctor.doctorId,
              previousDoctorName: admission.supervisorDoctor.name,
              newDoctorId: toObjectId(doctorId),
              newDoctorName: doctor.name,
              changedAt,
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
  });

  // ── POST /indoor-patient/:id/expense ────────────────────────────────────────
  fastify.post("/indoor-patient/:id/expense", addExpenseSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });
      const { type, itemId, name, price, quantity, note, schemaId } = req.body;

      const addedAt = now();
      const addedBy = by(req);
      const resolvedItemId = itemId ? toObjectId(itemId) : null;

      const update = {
        $push: {
          expenses: {
            type,
            itemId: resolvedItemId,
            name: name.trim(),
            price,
            quantity,
            total: price * quantity,
            note: note ?? "",
            addedAt,
            addedBy,
          },
        },
        $set: { updated: { at: addedAt, by: addedBy } },
      };

      // Every test gets a reports[] entry for full visibility.
      // schemaId present  → online test: full report tracking shape.
      // schemaId absent   → offline test: lightweight tracking only.
      if (type === "test" && resolvedItemId) {
        update.$push.reports = schemaId
          ? {
              testId: resolvedItemId,
              name: name.trim(),
              schemaId: toObjectId(schemaId),
              report: {},
              isCompleted: false,
              completedAt: null,
              updatedAt: null,
              addedAt,
              addedBy,
            }
          : {
              testId: resolvedItemId,
              name: name.trim(),
              schemaId: null,
              addedAt,
              addedBy,
            };
      }

      const result = await col().updateOne({ _id, labId: labId(req) }, update);
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Patient not found" });
      return reply.code(201).send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to add expense" });
    }
  });

  // ── POST /indoor-patient/:id/payment ────────────────────────────────────────
  fastify.post("/indoor-patient/:id/payment", addPaymentSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });
      const { amount, note } = req.body;

      const collectedAt = now();
      const result = await col().updateOne(
        { _id, labId: labId(req) },
        {
          $push: { payments: { amount, collectedBy: by(req), collectedAt, note: note ?? "" } },
          $set: { updated: { at: collectedAt, by: by(req) } },
        },
      );

      if (result.matchedCount === 0) return reply.code(404).send({ error: "Patient not found" });
      return reply.code(201).send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to record payment" });
    }
  });

  // ── PATCH /indoor-patient/:id/release ────────────────────────────────────────
  fastify.patch("/indoor-patient/:id/release", releasePatientSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const admission = await col().findOne({ _id, labId: labId(req) });
      if (!admission) return reply.code(404).send({ error: "Patient not found" });
      if (admission.status !== "admitted") return reply.code(400).send({ error: "Patient is already released" });

      const { note } = req.body ?? {};
      const releaseTime = now();

      if (admission.space.bedNumber != null) {
        await spacesCol().updateOne(
          { _id: admission.space.spaceId, labId: labId(req) },
          {
            $pull: { "multiBedConf.booked": admission.space.bedNumber },
            $set: { updated: { at: releaseTime, by: by(req) } },
          },
        );
      } else {
        await spacesCol().updateOne(
          { _id: admission.space.spaceId, labId: labId(req) },
          { $set: { reserved: false, reservedNote: "", updated: { at: releaseTime, by: by(req) } } },
        );
      }

      await col().updateOne(
        { _id, labId: labId(req) },
        {
          $set: {
            status: "released",
            releasedAt: releaseTime,
            releasedBy: by(req),
            updated: { at: releaseTime, by: by(req) },
          },
          $push: {
            wardHistory: {
              fromSpaceId: admission.space.spaceId,
              fromSpaceName: admission.space.spaceName,
              fromBedNumber: admission.space.bedNumber,
              toSpaceId: null,
              toSpaceName: null,
              toBedNumber: null,
              chargePerDay: admission.space.chargePerDay,
              fromDate: admission.space.fromDate ?? admission.admittedAt,
              toDate: releaseTime,
              movedAt: releaseTime,
              movedBy: by(req),
              note: note ?? "Patient discharged",
            },
          },
        },
      );

      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to release patient" });
    }
  });
}

export default indoorPatientRoutes;
