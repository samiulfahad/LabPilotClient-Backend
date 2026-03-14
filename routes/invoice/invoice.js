import { ObjectId } from "mongodb";

const generateInvoiceId = () => {
  const letters = "ABCDEFGHIJKLMNPQRSTUVWXYZ";
  const digits = "123456789";

  const letterPool = letters.split("");
  let id = "";
  for (let i = 0; i < 3; i++) {
    const idx = Math.floor(Math.random() * letterPool.length);
    id += letterPool[idx];
    letterPool.splice(idx, 1);
  }

  const digitPool = digits.split("");
  for (let i = 0; i < 4; i++) {
    const idx = Math.floor(Math.random() * digitPool.length);
    id += digitPool[idx];
    digitPool.splice(idx, 1);
  }

  return id;
};

async function routes(fastify, options) {
  const invoices = () => fastify.mongo.db.collection("invoices");

  // ============================================================================
  // GET /invoice/required-data
  // ============================================================================
  fastify.get("/invoice/required-data", async (req, reply) => {
    try {
      const [referrers, tests] = await Promise.all([
        fastify.mongo.db.collection("referrers").find({}).sort({ createdAt: -1 }).toArray(),
        fastify.mongo.db.collection("myTestList").find({}).sort({ createdAt: -1 }).toArray(),
      ]);
      return { referrers, tests };
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch required data" });
    }
  });

  // ============================================================================
  // POST /invoice/add
  // ============================================================================
  fastify.post("/invoice/add", async (req, reply) => {
    try {
      const {
        patientName,
        gender,
        age,
        contactNumber,
        referrer,
        tests,
        totalAmount,
        priceAfterReferrerDiscount,
        labAdjustmentAmount,
        finalPrice,
        paidAmount,
      } = req.body;

      let invoiceId;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generateInvoiceId();
        const existing = await invoices().findOne({ invoiceId: candidate });
        if (!existing) {
          invoiceId = candidate;
          break;
        }
        await new Promise((res) => setTimeout(res, 10));
      }

      if (!invoiceId) {
        return reply.code(500).send({ error: "Failed to generate a unique invoice ID, please try again" });
      }

      await invoices().insertOne({
        labId: 123456,
        invoiceId,
        createdAt: Date.now(),
        patientName,
        gender,
        age,
        contactNumber,
        referrer,
        tests: tests.map((test) => ({
          testId: new ObjectId(test.testId),
          name: test.name,
          price: test.price,
          schemaId: test.schemaId ? new ObjectId(test.schemaId) : null,
          ...(test.schemaId && { report: {}, isCompleted: false }),
        })),
        totalAmount,
        priceAfterReferrerDiscount,
        labAdjustmentAmount,
        finalPrice,
        paidAmount,
        isDelivered: false,
      });

      return reply.code(201).send({ invoiceId, link: "https://labpilotpro.com/" + invoiceId });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to create invoice" });
    }
  });

  // ============================================================================
  // GET /invoice/all — paginated + optional date-range filter
  // ============================================================================
  fastify.get("/invoice/all", async (req, reply) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const cursor = req.query.cursor ? parseInt(req.query.cursor) : null;
      const startDate = req.query.startDate ? parseInt(req.query.startDate) : null;
      const endDate = req.query.endDate ? parseInt(req.query.endDate) : null;

      const filter = { isDeleted: { $ne: true } };
      if (startDate || endDate || cursor) {
        filter.createdAt = {};
        if (startDate) filter.createdAt.$gte = startDate;
        if (endDate) filter.createdAt.$lte = endDate;
        if (cursor) filter.createdAt.$lt = cursor;
      }

      const result = await invoices()
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(limit + 1)
        .toArray();

      const hasMore = result.length > limit;
      if (hasMore) result.pop();

      return reply.send({
        invoices: result,
        nextCursor: hasMore ? result[result.length - 1].createdAt : null,
        hasMore,
      });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch invoices" });
    }
  });

  // ============================================================================
  // GET /invoice/deleted — paginated + optional date-range filter (on deletedAt)
  // ============================================================================
  fastify.get("/invoice/deleted", async (req, reply) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const cursor = req.query.cursor ? parseInt(req.query.cursor) : null;
      const startDate = req.query.startDate ? parseInt(req.query.startDate) : null;
      const endDate = req.query.endDate ? parseInt(req.query.endDate) : null;

      const filter = { isDeleted: true };
      if (startDate || endDate || cursor) {
        filter.deletedAt = {};
        if (startDate) filter.deletedAt.$gte = startDate;
        if (endDate) filter.deletedAt.$lte = endDate;
        if (cursor) filter.deletedAt.$lt = cursor;
      }

      const result = await invoices()
        .find(filter)
        .sort({ deletedAt: -1 })
        .limit(limit + 1)
        .toArray();

      const hasMore = result.length > limit;
      if (hasMore) result.pop();

      return reply.send({
        invoices: result,
        nextCursor: hasMore ? result[result.length - 1].deletedAt : null,
        hasMore,
      });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch deleted invoices" });
    }
  });

  // ============================================================================
  // GET /invoice/:invoiceId
  // ============================================================================
  fastify.get("/invoice/:invoiceId", async (req, reply) => {
    try {
      const invoice = await invoices().findOne({ invoiceId: req.params.invoiceId });
      if (!invoice) return reply.code(404).send({ error: "Invoice not found" });
      return reply.send(invoice);
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch invoice" });
    }
  });

  // ============================================================================
  // PATCH /invoice/:invoiceId/patient-info
  // ============================================================================
  fastify.patch("/invoice/:invoiceId/patient-info", async (req, reply) => {
    try {
      const { invoiceId } = req.params;
      const { patientName, gender, age, contactNumber } = req.body;

      if (!patientName || !gender || !age || !contactNumber) {
        return reply.code(400).send({ error: "patientName, gender, age, and contactNumber are all required" });
      }

      const invoice = await invoices().findOne({ invoiceId });
      if (!invoice) return reply.code(404).send({ error: "Invoice not found" });

      const update = {
        patientName: patientName.trim(),
        gender,
        age: Number(age),
        contactNumber: contactNumber.trim(),
      };

      await invoices().updateOne({ invoiceId }, { $set: update });
      return reply.send({ success: true, ...update });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to update patient info" });
    }
  });

  // ============================================================================
  // PATCH /invoice/:invoiceId/collect-due
  // ============================================================================
  fastify.patch("/invoice/:invoiceId/collect-due", async (req, reply) => {
    try {
      const { invoiceId } = req.params;
      const invoice = await invoices().findOne({ invoiceId });
      if (!invoice) return reply.code(404).send({ error: "Invoice not found" });

      const result = await invoices().updateOne({ invoiceId }, { $set: { paidAmount: invoice.finalPrice } });
      if (result.modifiedCount === 0) return reply.code(400).send({ error: "Nothing to update" });

      return reply.send({ success: true, paidAmount: invoice.finalPrice });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to collect due amount" });
    }
  });

  // ============================================================================
  // PATCH /invoice/:invoiceId/mark-delivered
  // ============================================================================
  fastify.patch("/invoice/:invoiceId/mark-delivered", async (req, reply) => {
    try {
      const { invoiceId } = req.params;
      const invoice = await invoices().findOne({ invoiceId });
      if (!invoice) return reply.code(404).send({ error: "Invoice not found" });
      if (invoice.isDelivered) return reply.code(400).send({ error: "Invoice is already marked as delivered" });

      await invoices().updateOne({ invoiceId }, { $set: { isDelivered: true } });
      return reply.send({ success: true });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to mark invoice as delivered" });
    }
  });

  // ============================================================================
  // PATCH /invoice/:invoiceId/delete — soft delete
  // ============================================================================
  fastify.patch("/invoice/:invoiceId/delete", async (req, reply) => {
    try {
      const { invoiceId } = req.params;
      const invoice = await invoices().findOne({ invoiceId });
      if (!invoice) return reply.code(404).send({ error: "Invoice not found" });
      if (invoice.isDeleted) return reply.code(400).send({ error: "Invoice is already deleted" });

      await invoices().updateOne({ invoiceId }, { $set: { isDeleted: true, deletedAt: Date.now() } });
      return reply.send({ success: true });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to delete invoice" });
    }
  });
}

export default routes;
