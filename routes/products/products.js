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
  },
};

const productIdParamSchema = {
  type: "object",
  required: ["productId"],
  properties: {
    productId: { type: "string", minLength: 24, maxLength: 24 },
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

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
        summary: "Get all products for the lab",
      },
    },
    async (req, reply) => {
      try {
        const products = await col()
          .find({ labId: labId(req), isDeleted: false }, { projection: { labId: 0 } })
          .sort({ createdAt: -1 })
          .toArray();
        return reply.send({ products });
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
          isDeleted: false,
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
        const { name, price, description } = req.body;

        // Duplicate name check within the lab
        const exists = await col().findOne(
          { labId: labId(req), name: { $regex: `^${name.trim()}$`, $options: "i" }, isDeleted: false },
          { projection: { _id: 1 } },
        );
        if (exists) return reply.code(409).send({ error: "A product with this name already exists" });

        const now = Date.now();
        const result = await col().insertOne({
          labId: labId(req),
          name: name.trim(),
          price,
          description: description?.trim() ?? null,
          createdAt: now,
          updatedAt: now,
          createdBy: { id: userId(req), name: req.user.name },
          isDeleted: false,
        });

        return reply.code(201).send({ _id: result.insertedId, name, price, description: description?.trim() ?? null });
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
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const { productId } = req.params;
        const { name, price, description } = req.body;

        const product = await col().findOne(
          { _id: toObjectId(productId), labId: labId(req), isDeleted: false },
          { projection: { _id: 1 } },
        );
        if (!product) return reply.code(404).send({ error: "Product not found" });

        // Duplicate name check (exclude self)
        if (name) {
          const duplicate = await col().findOne({
            _id: { $ne: toObjectId(productId) },
            labId: labId(req),
            name: { $regex: `^${name.trim()}$`, $options: "i" },
            isDeleted: false,
          });
          if (duplicate) return reply.code(409).send({ error: "A product with this name already exists" });
        }

        const update = { updatedAt: Date.now() };
        if (name !== undefined) update.name = name.trim();
        if (price !== undefined) update.price = price;
        if (description !== undefined) update.description = description?.trim() ?? null;

        await col().updateOne({ _id: toObjectId(productId), labId: labId(req) }, { $set: update });

        return reply.send({ success: true, ...update });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to update product" });
      }
    },
  );

  // ── DELETE /products/:productId ───────────────────────────────────────────
  fastify.delete(
    "/products/:productId",
    {
      schema: {
        tags: ["Products"],
        summary: "Soft delete a product",
        params: productIdParamSchema,
      },
    },
    async (req, reply) => {
      try {
        const { productId } = req.params;

        const product = await col().findOne(
          { _id: toObjectId(productId), labId: labId(req), isDeleted: false },
          { projection: { _id: 1 } },
        );
        if (!product) return reply.code(404).send({ error: "Product not found" });

        await col().updateOne(
          { _id: toObjectId(productId), labId: labId(req) },
          {
            $set: {
              isDeleted: true,
              deletedAt: Date.now(),
              deletedBy: { id: userId(req), name: req.user.name },
            },
          },
        );

        return reply.send({ success: true });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to delete product" });
      }
    },
  );
}

export default productRoutes;
