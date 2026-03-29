import bcrypt from "bcryptjs";
import toObjectId from "../../utils/db.js";

const changePhoneSchema = {
  schema: {
    tags: ["Account"],
    summary: "Change own phone number",
    body: {
      type: "object",
      required: ["phone", "currentPassword"],
      additionalProperties: false,
      properties: {
        phone: { type: "string", minLength: 10, maxLength: 15 },
        currentPassword: { type: "string", minLength: 1 },
      },
    },
  },
};

const changePasswordSchema = {
  schema: {
    tags: ["Account"],
    summary: "Change own password",
    body: {
      type: "object",
      required: ["currentPassword", "newPassword"],
      additionalProperties: false,
      properties: {
        currentPassword: { type: "string", minLength: 1 },
        newPassword: { type: "string", minLength: 6, maxLength: 60 },
      },
    },
  },
};

const revokeSessionSchema = {
  schema: {
    tags: ["Account"],
    summary: "Revoke a specific session by deviceId",
    params: {
      type: "object",
      required: ["deviceId"],
      properties: {
        deviceId: { type: "string", minLength: 1 },
      },
    },
  },
};

async function accountRoutes(fastify) {
  const staffCol = () => fastify.mongo.db.collection("staffs");
  const tokenCol = () => fastify.mongo.db.collection("tokens");
  const myId = (req) => toObjectId(req.user.id);

  fastify.addHook("onRequest", fastify.authenticate);

  // ── GET /account ───────────────────────────────────────────────────────────
  fastify.get("/account", async (req, reply) => {
    try {
      const me = await staffCol().findOne(
        { _id: myId(req), "deletion.status": { $ne: true } },
        { projection: { password: 0 } },
      );
      if (!me) return reply.code(404).send({ error: "Account not found" });
      return me;
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch account" });
    }
  });

  // ── GET /account/sessions ──────────────────────────────────────────────────
  // List all active sessions for the current user
  fastify.get("/account/sessions", async (req, reply) => {
    try {
      const currentDeviceId = req.cookies?.deviceId ?? null;

      const sessions = await tokenCol()
        .find(
          { userId: req.user.id, expiresAt: { $gt: new Date() } },
          {
            projection: {
              refreshToken: 0, // never expose the hash
            },
          },
        )
        .sort({ lastUsedAt: -1 })
        .toArray();

      // Mark the current session so the frontend can highlight it
      const result = sessions.map((s) => ({
        ...s,
        isCurrent: s.deviceId === currentDeviceId,
      }));

      return { sessions: result, total: result.length };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch sessions" });
    }
  });

  // ── DELETE /account/sessions/:deviceId ────────────────────────────────────
  // Revoke a specific session (can't revoke own current session via this route)
  fastify.delete("/account/sessions/:deviceId", revokeSessionSchema, async (req, reply) => {
    try {
      const { deviceId } = req.params;
      const currentDeviceId = req.cookies?.deviceId ?? null;

      if (deviceId === currentDeviceId) {
        return reply.code(400).send({ error: "Use /logout to end your current session" });
      }

      const result = await tokenCol().deleteOne({
        userId: req.user.id,
        deviceId,
      });

      if (result.deletedCount === 0) {
        return reply.code(404).send({ error: "Session not found" });
      }

      return { success: true, message: "Session revoked" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to revoke session" });
    }
  });

  // ── PATCH /account/phone ───────────────────────────────────────────────────
  fastify.patch("/account/phone", changePhoneSchema, async (req, reply) => {
    try {
      const { phone: rawPhone, currentPassword } = req.body;
      const phone = rawPhone.trim();

      const me = await staffCol().findOne(
        { _id: myId(req), "deletion.status": { $ne: true } },
        { projection: { password: 1, phone: 1, labKey: 1 } },
      );
      if (!me) return reply.code(404).send({ error: "Account not found" });

      const valid = await bcrypt.compare(currentPassword, me.password);
      if (!valid) return reply.code(401).send({ error: "Incorrect current password" });

      if (me.phone === phone) {
        return reply.code(400).send({ error: "New phone is the same as the current one" });
      }

      // Uniqueness within the same lab (keyed by labKey since labId may be string or ObjectId)
      const taken = await staffCol().findOne(
        {
          labKey: me.labKey,
          phone,
          _id: { $ne: myId(req) },
          "deletion.status": { $ne: true },
        },
        { projection: { _id: 1 } },
      );
      if (taken) return reply.code(409).send({ error: "Phone number already in use" });

      await staffCol().updateOne(
        { _id: myId(req) },
        {
          $set: {
            phone,
            updated: { at: Date.now(), by: { id: req.user.id, name: req.user.name } },
          },
        },
      );

      return { success: true, message: "Phone number updated successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update phone number" });
    }
  });

  // ── PATCH /account/password ────────────────────────────────────────────────
  fastify.patch("/account/password", changePasswordSchema, async (req, reply) => {
    try {
      const { currentPassword, newPassword } = req.body;

      const me = await staffCol().findOne(
        { _id: myId(req), "deletion.status": { $ne: true } },
        { projection: { password: 1 } },
      );
      if (!me) return reply.code(404).send({ error: "Account not found" });

      const valid = await bcrypt.compare(currentPassword, me.password);
      if (!valid) return reply.code(401).send({ error: "Incorrect current password" });

      const same = await bcrypt.compare(newPassword, me.password);
      if (same) return reply.code(400).send({ error: "New password must differ from current password" });

      const hash = await bcrypt.hash(newPassword, 10);
      await staffCol().updateOne(
        { _id: myId(req) },
        {
          $set: {
            password: hash,
            updated: { at: Date.now(), by: { id: req.user.id, name: req.user.name } },
          },
        },
      );

      return { success: true, message: "Password updated successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update password" });
    }
  });
}

export default accountRoutes;
