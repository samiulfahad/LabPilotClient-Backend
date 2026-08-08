import toObjectId from "../../utils/db.js";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const VALID_TYPES = ["medicine", "product", "service"];

const catalogBodySchema = {
  type: "object",
  required: ["type", "name", "price"],
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: VALID_TYPES },
    name: { type: "string", minLength: 1, maxLength: 100 },
    price: { type: "number", minimum: 0, maximum: 10000000 },
    description: { type: "string", maxLength: 500 },
    // medicine & product only
    hasStock: { type: "boolean", default: false },
    stock: { type: "integer", minimum: 0, default: 0 },
    // medicine only
    unitType: { type: "string", enum: ["stripe", "bottle", "vial", "sachet", "piece"] },
    unitQty: { type: ["integer", "null"], minimum: 1 },
  },
};

const catalogIdParamSchema = {
  type: "object",
  required: ["itemId"],
  properties: {
    itemId: { type: "string", minLength: 24, maxLength: 24 },
  },
};

const catalogQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: VALID_TYPES },
    search: { type: "string", maxLength: 100, default: "" },
    page: { type: "integer", minimum: 1, default: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  },
};

const stockAdjustSchema = {
  type: "object",
  required: ["delta"],
  additionalProperties: false,
  properties: {
    delta: { type: "integer" },
    note: { type: "string", maxLength: 200 },
  },
};

// Price-only update — separate from info, so a price change never risks
// touching name/description/unit/stock-tracking fields.
const updateItemPriceSchema = {
  type: "object",
  required: ["price"],
  additionalProperties: false,
  properties: {
    price: { type: "number", minimum: 0, maximum: 10000000 },
  },
};

// Info-only update — name, description, unit, and the hasStock toggle.
// Deliberately excludes `price` (its own route) and raw `stock` (numeric
// stock changes always go through /stock/adjust so every change carries a
// delta + note, i.e. an audit trail).
const updateItemInfoSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    description: { type: ["string", "null"], maxLength: 500 },
    hasStock: { type: "boolean" },
    unitType: { type: "string", enum: ["stripe", "bottle", "vial", "sachet", "piece"] },
    unitQty: { type: ["integer", "null"], minimum: 1 },
  },
};

// ─── Per-type limit config ─────────────────────────────────────────────────────
// Limits now live on the lab record per catalog type (limit.maxMedicine /
// limit.maxProduct / limit.maxService), mirroring limit.maxReferrer in
// referrerRoutes.js. null/missing means "no limit set" for that type.

const LIMIT_FIELD_BY_TYPE = {
  medicine: "maxMedicine",
  product: "maxProduct",
  service: "maxService",
};

const TYPE_LABEL_BN = {
  medicine: "ওষুধ",
  product: "পণ্য",
  service: "সেবা",
};

// ─── Routes ───────────────────────────────────────────────────────────────────

async function productRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("products");
  const labsCollection = fastify.mongo.db.collection("labs");
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("onRequest", fastify.authorize("manageProducts"));

  // ── GET /products ──────────────────────────────────────────────────────────
  fastify.get(
    "/products",
    {
      schema: {
        tags: ["Products"],
        summary: "List catalog items with optional type filter, search, and pagination",
        querystring: catalogQuerySchema,
      },
    },
    async (req, reply) => {
      try {
        const { type, search = "", page = 1, limit = 50 } = req.query;
        const skip = (page - 1) * limit;

        const filter = { labId: labId(req) };
        if (type) filter.type = type;
        if (search.trim()) {
          filter.$or = [
            { name: { $regex: search.trim(), $options: "i" } },
            { description: { $regex: search.trim(), $options: "i" } },
          ];
        }

        const [items, total, typeTotals, lab] = await Promise.all([
          col()
            .find(filter, { projection: { labId: 0 } })
            .sort({ _id: -1 })
            .skip(skip)
            .limit(limit)
            .toArray(),
          col().countDocuments(filter),
          col()
            .aggregate([{ $match: { labId: labId(req) } }, { $group: { _id: "$type", count: { $sum: 1 } } }])
            .toArray(),
          labsCollection.findOne(
            { _id: labId(req) },
            { projection: { "limit.maxMedicine": 1, "limit.maxProduct": 1, "limit.maxService": 1 } },
          ),
        ]);

        const totalsByType = { medicine: 0, product: 0, service: 0 };
        for (const row of typeTotals) {
          if (row._id in totalsByType) totalsByType[row._id] = row.count;
        }

        const maxByType = {
          medicine: typeof lab?.limit?.maxMedicine === "number" ? lab.limit.maxMedicine : null,
          product: typeof lab?.limit?.maxProduct === "number" ? lab.limit.maxProduct : null,
          service: typeof lab?.limit?.maxService === "number" ? lab.limit.maxService : null,
        };

        return reply.send({
          items,
          products: items,
          pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
          totalsByType,
          maxByType,
        });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch catalog" });
      }
    },
  );

  // ── POST /products ─────────────────────────────────────────────────────────
  fastify.post(
    "/products",
    { schema: { tags: ["Products"], summary: "Create a catalog item", body: catalogBodySchema } },
    async (req, reply) => {
      try {
        const { type, name, price, description, hasStock = false, stock = 0, unitType, unitQty } = req.body;

        // ── Per-type catalog limit check ────────────────────────────────────
        // Authoritative gate — the frontend also disables its "New Item"
        // button once the limit is reached, but that's UX only. No
        // "upgrade" messaging here; points the admin to contact support.
        const limitField = LIMIT_FIELD_BY_TYPE[type];
        const lab = await labsCollection.findOne({ _id: labId(req) }, { projection: { [`limit.${limitField}`]: 1 } });
        const maxForType = lab?.limit?.[limitField];

        if (typeof maxForType === "number") {
          const currentCount = await col().countDocuments({ labId: labId(req), type });
          if (currentCount >= maxForType) {
            return reply.code(403).send({
              error: `আপনার ল্যাবে সর্বোচ্চ ${maxForType}টি ${TYPE_LABEL_BN[type]} যোগ করা যাবে। সীমা পূর্ণ হয়েছে। সীমা বাড়াতে আমাদের সাথে যোগাযোগ করুন।`,
              code: "CATALOG_LIMIT_REACHED",
              limit: maxForType,
              current: currentCount,
            });
          }
        }

        const exists = await col().findOne(
          { labId: labId(req), type, name: { $regex: `^${name.trim()}$`, $options: "i" } },
          { projection: { _id: 1 } },
        );
        if (exists) return reply.code(409).send({ error: `A ${type} with this name already exists` });

        const effectiveHasStock = type === "service" ? false : hasStock;

        const doc = {
          labId: labId(req),
          type,
          name: name.trim(),
          price,
          description: description?.trim() ?? null,
          hasStock: effectiveHasStock,
          stock: effectiveHasStock ? stock : null,
          unitType: type === "medicine" ? (unitType ?? "stripe") : null,
          unitQty: type === "medicine" && unitType !== "piece" ? (unitQty ?? null) : null,
        };

        const result = await col().insertOne(doc);
        return reply.code(201).send({ _id: result.insertedId, ...doc });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to create item" });
      }
    },
  );

  // ── PATCH /products/:itemId/price ──────────────────────────────────────────
  fastify.patch(
    "/products/:itemId/price",
    {
      schema: {
        tags: ["Products"],
        summary: "Update the price of a catalog item",
        params: catalogIdParamSchema,
        body: updateItemPriceSchema,
      },
    },
    async (req, reply) => {
      try {
        const { itemId } = req.params;
        const { price } = req.body;

        const result = await col().updateOne({ _id: toObjectId(itemId), labId: labId(req) }, { $set: { price } });
        if (result.matchedCount === 0) return reply.code(404).send({ error: "Item not found" });

        return reply.send({ success: true, price });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to update price" });
      }
    },
  );

  // ── PATCH /products/:itemId/info ───────────────────────────────────────────
  fastify.patch(
    "/products/:itemId/info",
    {
      schema: {
        tags: ["Products"],
        summary: "Update name, description, unit, or stock-tracking toggle of a catalog item",
        params: catalogIdParamSchema,
        body: updateItemInfoSchema,
      },
    },
    async (req, reply) => {
      try {
        const { itemId } = req.params;
        const { name, description, hasStock, unitType, unitQty } = req.body;

        const existing = await col().findOne(
          { _id: toObjectId(itemId), labId: labId(req) },
          { projection: { _id: 1, type: 1, hasStock: 1 } },
        );
        if (!existing) return reply.code(404).send({ error: "Item not found" });

        if (name) {
          const dup = await col().findOne({
            _id: { $ne: toObjectId(itemId) },
            labId: labId(req),
            type: existing.type,
            name: { $regex: `^${name.trim()}$`, $options: "i" },
          });
          if (dup) return reply.code(409).send({ error: `A ${existing.type} with this name already exists` });
        }

        const update = {};
        if (name !== undefined) update.name = name.trim();
        if (description !== undefined) update.description = description?.trim() ?? null;

        if (hasStock !== undefined && existing.type !== "service") {
          update.hasStock = hasStock;
          if (!hasStock) {
            // Turning tracking off clears the number outright.
            update.stock = null;
          } else if (!existing.hasStock) {
            // Turning tracking on (from off) starts at 0 — the actual
            // count is then set via /stock/adjust, which keeps every
            // stock change attached to a delta + note.
            update.stock = 0;
          }
        }

        if (existing.type === "medicine") {
          if (unitType !== undefined) {
            update.unitType = unitType;
            update.unitQty = unitType === "piece" ? null : (unitQty ?? null);
          } else if (unitQty !== undefined) {
            update.unitQty = unitQty;
          }
        }

        await col().updateOne({ _id: toObjectId(itemId), labId: labId(req) }, { $set: update });
        return reply.send({ success: true, ...update });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to update item info" });
      }
    },
  );

  // ── POST /products/:itemId/stock/adjust ────────────────────────────────────
  fastify.post(
    "/products/:itemId/stock/adjust",
    {
      schema: {
        tags: ["Products"],
        summary: "Adjust stock by delta",
        params: catalogIdParamSchema,
        body: stockAdjustSchema,
      },
    },
    async (req, reply) => {
      try {
        const { itemId } = req.params;
        const { delta, note } = req.body;

        const item = await col().findOne(
          { _id: toObjectId(itemId), labId: labId(req) },
          { projection: { _id: 1, stock: 1, hasStock: 1, type: 1 } },
        );
        if (!item) return reply.code(404).send({ error: "Item not found" });
        if (item.type === "service" || !item.hasStock) {
          return reply.code(400).send({ error: "This item does not track stock" });
        }

        const newStock = (item.stock ?? 0) + delta;
        if (newStock < 0) return reply.code(400).send({ error: "Stock cannot go below zero" });

        await col().updateOne(
          { _id: toObjectId(itemId), labId: labId(req) },
          {
            $set: {
              stock: newStock,
              lastStockAdjustment: {
                delta,
                note: note ?? null,
                at: Date.now(),
              },
            },
          },
        );

        return reply.send({ success: true, stock: newStock });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to adjust stock" });
      }
    },
  );

  // ── DELETE /products/:itemId ───────────────────────────────────────────────
  fastify.delete(
    "/products/:itemId",
    {
      schema: { tags: ["Products"], summary: "Delete a catalog item", params: catalogIdParamSchema },
    },
    async (req, reply) => {
      try {
        const result = await col().deleteOne({ _id: toObjectId(req.params.itemId), labId: labId(req) });
        if (result.deletedCount === 0) return reply.code(404).send({ error: "Item not found" });
        return reply.send({ success: true });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to delete item" });
      }
    },
  );
}

export default productRoutes;
