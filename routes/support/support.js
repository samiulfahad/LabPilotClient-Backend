import toObjectId from "../../utils/db.js";

// Fixed staff number that gets an SMS ping whenever a support message
// comes in — not the lab's own number, this is internal.
const SUPPORT_NOTIFY_NUMBER = "01723939836";

const sendMessageSchema = {
  schema: {
    tags: ["Support"],
    summary: "Send a support message / complaint",
    body: {
      type: "object",
      required: ["message", "contact"],
      additionalProperties: false,
      properties: {
        message: { type: "string", minLength: 1, maxLength: 2000 },
        contact: { type: "string", pattern: "^\\d{11}$", description: "11-digit contact number" },
      },
    },
  },
};

async function supportRoutes(fastify) {
  const supportMessagesCollection = () => fastify.mongo.db.collection("supportMessages");
  const labsCollection = () => fastify.mongo.db.collection("labs");

  // ── POST /support ────────────────────────────────────────────────────────
  fastify.post("/support", { onRequest: [fastify.authenticate], ...sendMessageSchema }, async (req, reply) => {
    const { message, contact } = req.body || {};

    // Only need the name here — everything else on the lab doc is unused by
    // this route, so keep the query narrow.
    const lab = await labsCollection().findOne({ _id: toObjectId(req.user.labId) }, { projection: { name: 1 } });

    const doc = {
      labId: toObjectId(req.user.labId),
      labKey: req.user.labKey,
      labName: lab?.name ?? null,
      staffId: toObjectId(req.user.id),
      staffName: req.user.name,
      contact,
      message: message.trim(),
      status: "unread",
      createdAt: new Date(),
    };

    const { insertedId } = await supportMessagesCollection().insertOne(doc);

    // Best-effort notification — a failed SMS shouldn't lose the message,
    // it's already saved above and pullable from the admin side.
    try {
      await fastify.sendSMS({
        number: SUPPORT_NOTIFY_NUMBER,
        message: `New support msg from ${req.user.labKey}, ${lab?.name ?? "Unknown Lab"}`,
      });
    } catch (err) {
      fastify.log.error({ err, id: insertedId }, "Support message SMS notify failed");
    }

    return reply.send({ message: "Your message has been sent." });
  });
}

export default supportRoutes;
