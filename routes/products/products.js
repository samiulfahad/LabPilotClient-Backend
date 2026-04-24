import toObjectId from "../../utils/db.js";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const productBodySchema = {
  type: "object",
  required: ["name", "price"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    price: { type: "number", minimum: 0, maximum: 10000000 },
    description: { type: "string", maxLength: 500 },
    unit: { type: "string", maxLength: 50 },
    hasStock: { type: "boolean", default: false },
    stock: { type: "integer", minimum: 0, default: 0 },
  },
};

const productIdParamSchema = {
  type: "object",
  required: ["productId"],
  properties: {
    productId: { type: "string", minLength: 24, maxLength: 24 },
  },
};

const productQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
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
    delta: { type: "integer" }, // positive = add, negative = remove
    note: { type: "string", maxLength: 200 },
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

const LAB_PRODUCT_LIMIT = 500;

async function productRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("products");
  const labId = (req) => toObjectId(req.user.labId);
  const userId = (req) => toObjectId(req.user.id);

  fastify.addHook("onRequest", fastify.authenticate);

  // ── GET /products ─────────────────────────────────────────────────────────
  fastify.get(
    "/products",
    {
      schema: {
        tags: ["Products"],
        summary: "Get all products for the lab (search + pagination)",
        querystring: productQuerySchema,
      },
    },
    async (req, reply) => {
      try {
        const { search = "", page = 1, limit = 50 } = req.query;
        const skip = (page - 1) * limit;

        const filter = { labId: labId(req) };
        if (search.trim()) {
          filter.$or = [
            { name: { $regex: search.trim(), $options: "i" } },
            { description: { $regex: search.trim(), $options: "i" } },
          ];
        }

        const [products, total] = await Promise.all([
          col()
            .find(filter, { projection: { labId: 0 } })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .toArray(),
          col().countDocuments(filter),
        ]);

        return reply.send({
          products,
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          },
        });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch products" });
      }
    },
  );

  // ── GET /products/:productId ──────────────────────────────────────────────
  fastify.get(
    "/products/:productId",
    {
      schema: {
        tags: ["Products"],
        summary: "Get a single product by ID",
        params: productIdParamSchema,
      },
    },
    async (req, reply) => {
      try {
        const product = await col().findOne({
          _id: toObjectId(req.params.productId),
          labId: labId(req),
        });
        if (!product) return reply.code(404).send({ error: "Product not found" });
        return reply.send(product);
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch product" });
      }
    },
  );

  // ── POST /products ────────────────────────────────────────────────────────
  fastify.post(
    "/products",
    {
      schema: {
        tags: ["Products"],
        summary: "Create a new product",
        body: productBodySchema,
      },
    },
    async (req, reply) => {
      try {
        const { name, price, description, unit, hasStock = false, stock = 0 } = req.body;

        // ── 500-product limit ──────────────────────────────────────────────
        const count = await col().countDocuments({ labId: labId(req) });
        if (count >= LAB_PRODUCT_LIMIT) {
          return reply.code(403).send({
            error: `Product limit reached. Each lab can have a maximum of ${LAB_PRODUCT_LIMIT} products.`,
          });
        }

        // ── Duplicate name check ───────────────────────────────────────────
        const exists = await col().findOne(
          { labId: labId(req), name: { $regex: `^${name.trim()}$`, $options: "i" } },
          { projection: { _id: 1 } },
        );
        if (exists) return reply.code(409).send({ error: "A product with this name already exists" });

        const now = Date.now();
        const result = await col().insertOne({
          labId: labId(req),
          name: name.trim(),
          price,
          description: description?.trim() ?? null,
          unit: unit?.trim() ?? null,
          hasStock,
          stock: hasStock ? stock : null,
          createdAt: now,
          updatedAt: now,
          createdBy: { id: userId(req), name: req.user.name },
        });

        return reply.code(201).send({
          _id: result.insertedId,
          name: name.trim(),
          price,
          description: description?.trim() ?? null,
          unit: unit?.trim() ?? null,
          hasStock,
          stock: hasStock ? stock : null,
        });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to create product" });
      }
    },
  );

  // ── PATCH /products/:productId ────────────────────────────────────────────
  fastify.patch(
    "/products/:productId",
    {
      schema: {
        tags: ["Products"],
        summary: "Update a product",
        params: productIdParamSchema,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            price: { type: "number", minimum: 0, maximum: 10000000 },
            description: { type: ["string", "null"], maxLength: 500 },
            unit: { type: ["string", "null"], maxLength: 50 },
            hasStock: { type: "boolean" },
            stock: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const { productId } = req.params;
        const { name, price, description, unit, hasStock, stock } = req.body;

        const product = await col().findOne(
          { _id: toObjectId(productId), labId: labId(req) },
          { projection: { _id: 1, hasStock: 1 } },
        );
        if (!product) return reply.code(404).send({ error: "Product not found" });

        // ── Duplicate name check ───────────────────────────────────────────
        if (name) {
          const duplicate = await col().findOne({
            _id: { $ne: toObjectId(productId) },
            labId: labId(req),
            name: { $regex: `^${name.trim()}$`, $options: "i" },
          });
          if (duplicate) return reply.code(409).send({ error: "A product with this name already exists" });
        }

        const effectiveHasStock = hasStock !== undefined ? hasStock : product.hasStock;

        const update = { updatedAt: Date.now() };
        if (name !== undefined) update.name = name.trim();
        if (price !== undefined) update.price = price;
        if (description !== undefined) update.description = description?.trim() ?? null;
        if (unit !== undefined) update.unit = unit?.trim() ?? null;
        if (hasStock !== undefined) {
          update.hasStock = hasStock;
          if (!hasStock) update.stock = null;
        }
        if (stock !== undefined && effectiveHasStock) {
          update.stock = stock;
        }

        await col().updateOne({ _id: toObjectId(productId), labId: labId(req) }, { $set: update });
        return reply.send({ success: true, ...update });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to update product" });
      }
    },
  );

  // ── POST /products/:productId/stock/adjust ────────────────────────────────
  fastify.post(
    "/products/:productId/stock/adjust",
    {
      schema: {
        tags: ["Products"],
        summary: "Adjust product stock by a delta (positive or negative)",
        params: productIdParamSchema,
        body: stockAdjustSchema,
      },
    },
    async (req, reply) => {
      try {
        const { productId } = req.params;
        const { delta, note } = req.body;

        const product = await col().findOne(
          { _id: toObjectId(productId), labId: labId(req) },
          { projection: { _id: 1, stock: 1, hasStock: 1 } },
        );
        if (!product) return reply.code(404).send({ error: "Product not found" });

        if (!product.hasStock) {
          return reply.code(400).send({ error: "This product does not track stock" });
        }

        const currentStock = product.stock ?? 0;
        const newStock = currentStock + delta;
        if (newStock < 0) {
          return reply.code(400).send({ error: "Stock cannot go below zero" });
        }

        await col().updateOne(
          { _id: toObjectId(productId), labId: labId(req) },
          {
            $set: {
              stock: newStock,
              updatedAt: Date.now(),
              lastStockAdjustment: {
                delta,
                note: note ?? null,
                by: { id: userId(req), name: req.user.name },
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

  // ── DELETE /products/:productId ───────────────────────────────────────────
  fastify.delete(
    "/products/:productId",
    {
      schema: {
        tags: ["Products"],
        summary: "Permanently delete a product",
        params: productIdParamSchema,
      },
    },
    async (req, reply) => {
      try {
        const { productId } = req.params;

        const result = await col().deleteOne({
          _id: toObjectId(productId),
          labId: labId(req),
        });

        if (result.deletedCount === 0) return reply.code(404).send({ error: "Product not found" });

        return reply.send({ success: true });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to delete product" });
      }
    },
  );
}

export default productRoutes;
