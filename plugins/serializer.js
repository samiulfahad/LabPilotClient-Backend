import fp from "fastify-plugin";
import { ObjectId } from "mongodb";

function normalizeIds(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof ObjectId) return value.toHexString();
  if (Array.isArray(value)) return value.map(normalizeIds);
  if (typeof value === "object" && typeof value.toHexString === "function") return value.toHexString();
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = normalizeIds(value[key]);
    return out;
  }
  return value;
}

export default fp(async function serializerPlugin(fastify) {
  fastify.setReplySerializer(function (payload) {
    return JSON.stringify(normalizeIds(payload));
  });
});
