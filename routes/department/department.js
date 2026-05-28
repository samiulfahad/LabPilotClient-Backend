/**
 * departmentRoutes.js
 * Serves the canonical department and designation lists. No per-hospital DB storage.
 */

export const ALLOWED_DEPARTMENTS = [
  { value: "anesthesiology", label: "Anesthesiology" },
  { value: "cardiology", label: "Cardiology" },
  { value: "dentistry", label: "Dentistry" },
  { value: "dermatology", label: "Dermatology" },
  { value: "endocrinology", label: "Endocrinology" },
  { value: "ent", label: "ENT (Ear, Nose & Throat)" },
  { value: "gastroenterology", label: "Gastroenterology" },
  { value: "general", label: "General Medicine" },
  { value: "surgery", label: "General Surgery" },
  { value: "gynecology", label: "Gynecology & Obstetrics" },
  { value: "hematology", label: "Hematology" },
  { value: "nephrology", label: "Nephrology" },
  { value: "neurology", label: "Neurology" },
  { value: "nutrition", label: "Nutrition & Dietetics" },
  { value: "oncology", label: "Oncology" },
  { value: "ophthalmology", label: "Ophthalmology" },
  { value: "orthopedics", label: "Orthopedics" },
  { value: "pediatrics", label: "Pediatrics" },
  { value: "physiotherapy", label: "Physiotherapy & Rehab" },
  { value: "psychiatry", label: "Psychiatry" },
  { value: "pulmonology", label: "Pulmonology" },
  { value: "radiology", label: "Radiology & Imaging" },
  { value: "rheumatology", label: "Rheumatology" },
  { value: "urology", label: "Urology" },
  { value: "other", label: "Other" },
];

export const ALLOWED_DESIGNATIONS = [
  { value: "professor", label: "Professor" },
  { value: "associate_professor", label: "Associate Professor" },
  { value: "assistant_professor", label: "Assistant Professor" },
  { value: "consultant", label: "Consultant" },
  { value: "senior_consultant", label: "Senior Consultant" },
  { value: "resident", label: "Resident" },
  { value: "medical_officer", label: "Medical Officer" },
  { value: "house_officer", label: "House Officer" },
  { value: "intern", label: "Intern" },
  { value: "general_practitioner", label: "General Practitioner" },
  { value: "specialist", label: "Specialist" },
  { value: "other", label: "Other" },
];

export const ALLOWED_VALUES = new Set(ALLOWED_DEPARTMENTS.map((d) => d.value));
export const ALLOWED_DESIG_VALUES = new Set(ALLOWED_DESIGNATIONS.map((d) => d.value));

async function departmentRoutes(fastify) {
  // ── GET /departments ────────────────────────────────────────────────────────
  fastify.get(
    "/departments",
    { schema: { tags: ["Departments"], summary: "Get all available departments" } },
    async (_req, reply) => reply.send({ departments: ALLOWED_DEPARTMENTS }),
  );

  // ── GET /designations ───────────────────────────────────────────────────────
  fastify.get(
    "/designations",
    { schema: { tags: ["Departments"], summary: "Get all available designations" } },
    async (_req, reply) => reply.send({ designations: ALLOWED_DESIGNATIONS }),
  );
}

export default departmentRoutes;
