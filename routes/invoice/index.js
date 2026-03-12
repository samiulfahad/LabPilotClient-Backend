import { ObjectId } from "mongodb";
const collectionName = "myTestList";

async function routes(fastify, options) {
  const collection = fastify.mongo.db.collection(collectionName);

  // Helper to convert _id to string
  const toClientFormat = (doc) => {
    if (!doc) return null;
    return { ...doc, _id: doc._id.toString() };
  };

  // GET required data for creating invoice
  fastify.get("/invoice/required-data", async (req, reply) => {
    try {
      const referrers = await fastify.mongo.db.collection("referrers").find({}).sort({ createdAt: -1 }).toArray();
      const tests = await fastify.mongo.db.collection("myTestList").find({}).sort({ createdAt: -1 }).toArray();
      return { referrers, tests };
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch tests" });
    }
  });

  const generateInvoiceId = () => {
    const letters = "ABCDEFGHIJKLMNPQRSTUVWXYZ";
    const digits = "123456789";

    let id = "";

    const letterPool = letters.split("");
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

  // ============================================================================
  // POST create invoice
  // ============================================================================
  fastify.post("/invoice/add", async (req, reply) => {
    try {
      const {
        patientName,
        gender,
        age,
        contactNumber,
        referredBy,
        referrerCommission,
        tests,
        totalAmount,
        referrerDiscount,
        priceAfterReferrerDiscount,
        labAdjustmentAmount,
        finalPrice,
        paidAmount,
      } = req.body;

      // console.log(req.body);

      const invoicesCollection = fastify.mongo.db.collection("invoices");

      let invoiceId;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generateInvoiceId();
        const existing = await invoicesCollection.findOne({ invoiceId: candidate });
        if (!existing) {
          invoiceId = candidate;
          break;
        }
        await new Promise((res) => setTimeout(res, 10));
      }

      if (!invoiceId) {
        return reply.code(500).send({ error: "Failed to generate a unique invoice ID, please try again" });
      }

      const invoiceDoc = {
        labId: 123456,
        invoiceId,
        createdAt: Date.now(),
        patientName,
        gender,
        age,
        contactNumber,
        referredBy,
        tests: tests.map((test) => ({
          testId: new ObjectId(test.testId),
          name: test.name,
          price: test.price,
          schemaId: test.schemaId ? new ObjectId(test.schemaId) : null,
          ...(test.schemaId && { report: {}, isCompleted: false }),
        })),
        totalAmount,
        referrerDiscount,
        priceAfterReferrerDiscount,
        referrerCommission,
        labAdjustmentAmount,
        finalPrice,
        paidAmount,
        isDelivered: false,
      };

      await invoicesCollection.insertOne(invoiceDoc);
      return reply.code(201).send({ invoiceId, link: "https://labpilotpro.com/" + invoiceId });
    } catch (error) {
      console.log(error);
      return reply.code(500).send({ error: "Failed to create invoice" });
    }
  });

  // ============================================================================
  // GET all invoices — paginated + optional date-range filter
  // excludes soft-deleted invoices
  // ============================================================================
  fastify.get("/invoice/all", async (req, reply) => {
    try {
      const invoicesCollection = fastify.mongo.db.collection("invoices");

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

      const invoices = await invoicesCollection
        .aggregate([
          { $match: filter },
          { $sort: { createdAt: -1 } },
          { $limit: limit + 1 },
          {
            $lookup: {
              from: "referrers",
              localField: "referredBy",
              foreignField: "_id",
              as: "referredBy",
            },
          },
          {
            $addFields: {
              referredBy: { $arrayElemAt: ["$referredBy", 0] },
            },
          },
        ])
        .toArray();

      const hasMore = invoices.length > limit;
      if (hasMore) invoices.pop();

      const nextCursor = hasMore ? invoices[invoices.length - 1].createdAt : null;

      return reply.send({ invoices, nextCursor, hasMore });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch invoices" });
    }
  });

  // GET single invoice by invoiceId
  fastify.get("/invoice/:invoiceId", async (req, reply) => {
    try {
      const { invoiceId } = req.params;
      const invoicesCollection = fastify.mongo.db.collection("invoices");

      const [invoice] = await invoicesCollection
        .aggregate([
          { $match: { invoiceId: invoiceId } },
          {
            $lookup: {
              from: "referrers",
              localField: "referredBy",
              foreignField: "_id",
              as: "referredBy",
            },
          },
          {
            $addFields: {
              referredBy: { $arrayElemAt: ["$referredBy", 0] },
            },
          },
        ])
        .toArray();

      if (!invoice) {
        return reply.code(404).send({ error: "Invoice not found" });
      }

      return reply.send(invoice);
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch invoice" });
    }
  });

  // PATCH update patient info only (name, gender, age, contactNumber)
  fastify.patch("/invoice/:invoiceId/patient-info", async (req, reply) => {
    try {
      const { invoiceId } = req.params;

      const { patientName, gender, age, contactNumber } = req.body;

      if (!patientName || !gender || !age || !contactNumber) {
        return reply.code(400).send({ error: "patientName, gender, age, and contactNumber are all required" });
      }

      const invoicesCollection = fastify.mongo.db.collection("invoices");

      const invoice = await invoicesCollection.findOne({ invoiceId });
      if (!invoice) {
        return reply.code(404).send({ error: "Invoice not found" });
      }

      await invoicesCollection.updateOne(
        { invoiceId },
        {
          $set: {
            patientName: patientName.trim(),
            gender,
            age: Number(age),
            contactNumber: contactNumber.trim(),
          },
        },
      );

      return reply.send({ success: true, patientName, gender, age: Number(age), contactNumber });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to update patient info" });
    }
  });

  // PATCH collect due — sets paidAmount = finalPrice so due becomes 0
  fastify.patch("/invoice/:invoiceId/collect-due", async (req, reply) => {
    try {
      const { invoiceId } = req.params;
      const invoicesCollection = fastify.mongo.db.collection("invoices");
      const invoice = await invoicesCollection.findOne({ invoiceId });
      if (!invoice) {
        return reply.code(404).send({ error: "Invoice not found" });
      }

      const result = await invoicesCollection.updateOne({ invoiceId }, { $set: { paidAmount: invoice.finalPrice } });

      if (result.modifiedCount === 0) {
        return reply.code(400).send({ error: "Nothing to update" });
      }
      return reply.send({ success: true, paidAmount: invoice.finalPrice });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to collect due amount" });
    }
  });

  // PATCH mark delivered — sets isDelivered = true (one-way only)
  fastify.patch("/invoice/:invoiceId/mark-delivered", async (req, reply) => {
    try {
      const { invoiceId } = req.params;
      const invoicesCollection = fastify.mongo.db.collection("invoices");
      const invoice = await invoicesCollection.findOne({ invoiceId });
      if (!invoice) {
        return reply.code(404).send({ error: "Invoice not found" });
      }
      if (invoice.isDelivered) {
        return reply.code(400).send({ error: "Invoice is already marked as delivered" });
      }
      await invoicesCollection.updateOne({ invoiceId }, { $set: { isDelivered: true } });
      return reply.send({ success: true });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to mark invoice as delivered" });
    }
  });

  // ============================================================================
  // PATCH soft-delete invoice
  // ============================================================================
  fastify.patch("/invoice/:invoiceId/delete", async (req, reply) => {
    try {
      const { invoiceId } = req.params;
      const invoicesCollection = fastify.mongo.db.collection("invoices");
      const invoice = await invoicesCollection.findOne({ invoiceId });
      if (!invoice) return reply.code(404).send({ error: "Invoice not found" });
      if (invoice.isDeleted) return reply.code(400).send({ error: "Invoice is already deleted" });
      await invoicesCollection.updateOne({ invoiceId }, { $set: { isDeleted: true, deletedAt: Date.now() } });
      return reply.send({ success: true });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to delete invoice" });
    }
  });

  // ============================================================================
  // GET deleted invoices — paginated + date-range filter (on deletedAt)
  // ============================================================================
  fastify.get("/invoice/deleted", async (req, reply) => {
    try {
      const invoicesCollection = fastify.mongo.db.collection("invoices");

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

      const invoices = await invoicesCollection
        .aggregate([
          { $match: filter },
          { $sort: { deletedAt: -1 } },
          { $limit: limit + 1 },
          {
            $lookup: {
              from: "referrers",
              localField: "referredBy",
              foreignField: "_id",
              as: "referredBy",
            },
          },
          {
            $addFields: { referredBy: { $arrayElemAt: ["$referredBy", 0] } },
          },
        ])
        .toArray();

      const hasMore = invoices.length > limit;
      if (hasMore) invoices.pop();
      const nextCursor = hasMore ? invoices[invoices.length - 1].deletedAt : null;

      return reply.send({ invoices, nextCursor, hasMore });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch deleted invoices" });
    }
  });
}

export default routes;
