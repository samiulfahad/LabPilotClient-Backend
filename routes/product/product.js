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

// ─── Routes ───────────────────────────────────────────────────────────────────

const LAB_PRODUCT_LIMIT = 500;

async function productRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("products");
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);

  const requireManage = { onRequest: [fastify.authorize("manageProducts")] };

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

        const [items, total, typeTotals] = await Promise.all([
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
        ]);

        const totalsByType = { medicine: 0, product: 0, service: 0 };
        for (const row of typeTotals) {
          if (row._id in totalsByType) totalsByType[row._id] = row.count;
        }

        return reply.send({
          items,
          products: items,
          pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
          totalsByType,
        });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch catalog" });
      }
    },
  );

  // ── GET /products/:itemId ──────────────────────────────────────────────────
  fastify.get(
    "/products/:itemId",
    { schema: { tags: ["Products"], summary: "Get a single catalog item", params: catalogIdParamSchema } },
    async (req, reply) => {
      try {
        const item = await col().findOne({ _id: toObjectId(req.params.itemId), labId: labId(req) });
        if (!item) return reply.code(404).send({ error: "Item not found" });
        return reply.send(item);
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch item" });
      }
    },
  );

  // ── POST /products ─────────────────────────────────────────────────────────
  fastify.post(
    "/products",
    { ...requireManage, schema: { tags: ["Products"], summary: "Create a catalog item", body: catalogBodySchema } },
    async (req, reply) => {
      try {
        const { type, name, price, description, hasStock = false, stock = 0, unitType, unitQty } = req.body;

        const count = await col().countDocuments({ labId: labId(req) });
        if (count >= LAB_PRODUCT_LIMIT) {
          return reply.code(403).send({
            error: `Catalog limit reached. Each lab can have a maximum of ${LAB_PRODUCT_LIMIT} items.`,
          });
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

  // ── PATCH /products/:itemId ────────────────────────────────────────────────
  fastify.patch(
    "/products/:itemId",
    {
      ...requireManage,
      schema: {
        tags: ["Products"],
        summary: "Update a catalog item",
        params: catalogIdParamSchema,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            price: { type: "number", minimum: 0, maximum: 10000000 },
            description: { type: ["string", "null"], maxLength: 500 },
            hasStock: { type: "boolean" },
            stock: { type: "integer", minimum: 0 },
            unitType: { type: "string", enum: ["stripe", "bottle", "vial", "sachet", "piece"] },
            unitQty: { type: ["integer", "null"], minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const { itemId } = req.params;
        const { name, price, description, hasStock, stock } = req.body;

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

        const effectiveHasStock = hasStock !== undefined ? hasStock : existing.hasStock;
        const update = {};
        if (name !== undefined) update.name = name.trim();
        if (price !== undefined) update.price = price;
        if (description !== undefined) update.description = description?.trim() ?? null;
        if (hasStock !== undefined) {
          update.hasStock = existing.type === "service" ? false : hasStock;
          if (!update.hasStock) update.stock = null;
        }
        if (stock !== undefined && effectiveHasStock && existing.type !== "service") {
          update.stock = stock;
        }
        if (existing.type === "medicine") {
          const { unitType, unitQty } = req.body;
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
        return reply.code(500).send({ error: "Failed to update item" });
      }
    },
  );

  // ── POST /products/:itemId/stock/adjust ────────────────────────────────────
  fastify.post(
    "/products/:itemId/stock/adjust",
    {
      ...requireManage,
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
      ...requireManage,
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
