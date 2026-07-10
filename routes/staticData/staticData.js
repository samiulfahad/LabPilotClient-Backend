/**
 * departmentRoutes.js
 * Serves the canonical department, designation, and staff-permission lists.
 * No per-hospital DB storage.
 */

export const ALLOWED_MED_DEPARTMENTS = [
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

export const ALLOWED_PERMISSIONS = [
  { key: "createInvoice", label: "ইনভয়েস তৈরি", for: "both" },
  { key: "deleteInvoice", label: "ইনভয়েস ডিলিট", for: "both" },
  { key: "addExpense", label: "নতুন খরচ/ব্যয় তৈরি", for: "both" },
  { key: "deleteExpense", label: "খরচ/ব্যয় ডিলিট", for: "both" },
  { key: "cashmemo", label: "ক্যাশমেমু", for: "both" },
  { key: "salesReport", label: "সেলস রিপোর্ট", for: "both" },
  { key: "expenseReport", label: "এক্সপেন্স (খরচ/ব্যয়) রিপোর্ট", for: "both" },
  { key: "commissionReport", label: "কমিশন রিপোর্ট", for: "both" },
  { key: "collectionReport", label: "কালেকশন রিপোর্র", for: "both" },
  { key: "testReportDownload", label: "টেস্ট রিপোর্ট ডাউনলোড", for: "both" },
  { key: "testReportUpload", label: "টেস্ট রিপোর্ট আপলোড", for: "both" },
  { key: "manageProducts", label: "পণ্য, ঔষধ, সেবা ম্যানেজমেন্ট", for: "both" },
  { key: "manageReferrers", label: "রেফারার ম্যানেজমেন্ট", for: "both" },
  { key: "manageDoctors", label: "ডাক্তার ম্যানেজমেন্ট", for: "both" },
  { key: "manageTest", label: "ল্যাব টেস্ট ম্যানেজমেন্ট", for: "both" },
  { key: "manageBilling", label: "মাসিক বিলিং", for: "both" },
  { key: "admitPatient", label: "নতুন রোগী ভর্তি", for: "hospitalOnly" },
  { key: "deletePatient", label: "ভর্তি রোগীর তথ্য ডিলিট", for: "hospitalOnly" },
  { key: "releasePatient", label: "ভর্তি রোগী রিলিজ দেওয়া", for: "hospitalOnly" },
];

export const ALLOWED_DEPARTMENTS = new Set(ALLOWED_MED_DEPARTMENTS.map((d) => d.value));
export const ALLOWED_DESIG_VALUES = new Set(ALLOWED_DESIGNATIONS.map((d) => d.value));
export const ALLOWED_PERM_KEYS = new Set(ALLOWED_PERMISSIONS.map((p) => p.key));

async function staticDataRoutes(fastify) {
  // ── GET /departments ──────────────────────────────────────────────────────
  fastify.get(
    "/departments",
    { schema: { tags: ["Departments"], summary: "Get all available departments" } },
    async (_req, reply) => reply.send({ departments: ALLOWED_MED_DEPARTMENTS }),
  );

  // ── GET /designations ─────────────────────────────────────────────────────
  fastify.get(
    "/designations",
    { schema: { tags: ["Departments"], summary: "Get all available designations" } },
    async (_req, reply) => reply.send({ designations: ALLOWED_DESIGNATIONS }),
  );

  // ── GET /staff-permissions ────────────────────────────────────────────────
  fastify.get(
    "/staff-permissions",
    { schema: { tags: ["Staff"], summary: "Get all available staff permissions" } },
    async (_req, reply) => reply.send({ permissions: ALLOWED_PERMISSIONS }),
  );
}

export default staticDataRoutes;
