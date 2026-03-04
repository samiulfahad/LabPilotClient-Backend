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

  // POST create invoice
  const generateInvoiceId = () => {
    const now = new Date();
    const id = `${String(now.getFullYear() % 100).padStart(2, "0")}${String(now.getMonth() + 1).padStart(2, "0")}${String(
      now.getDate(),
    ).padStart(2, "0")}${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(
      now.getSeconds(),
    ).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0").slice(0, 2)}`;

    return parseInt(id, 10);
  };

  fastify.post("/invoice/add", async (req, reply) => {
    try {
      const {
        patientName,
        gender,
        age,
        contactNumber,
        referredBy,
        tests,
        totalAmount,
        hasReferrerDiscount,
        referrerDiscountPercentage,
        priceAfterReferrerDiscount,
        hasLabAdjustment,
        labAdjustmentAmount,
        finalPrice,
        paidAmount,
      } = req.body;

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
        invoiceId,
        patientName,
        gender,
        age,
        contactNumber,
        referredBy: referredBy,
        tests: tests.map((test) => ({
          testId: new ObjectId(test.testId),
          name: test.name,
          price: test.price,
          schemaId: test.schemaId ? new ObjectId(test.schemaId) : null,
          ...(test.schemaId && { report: {}, isCompleted: false }),
        })),
        totalAmount,
        hasReferrerDiscount,
        referrerDiscountPercentage,
        priceAfterReferrerDiscount,
        hasLabAdjustment,
        labAdjustmentAmount,
        finalPrice,
        paidAmount,
        isDelivered: false,
      };

      const result = await invoicesCollection.insertOne(invoiceDoc);
      return reply.code(201).send({ invoiceId, link: "https:/labpilotpro.com/" + invoiceId });
    } catch (error) {
      console.log(error);
      return reply.code(500).send({ error: "Failed to create invoice" });
    }
  });

  // GET all invoices
  fastify.get("/invoice/all", async (req, reply) => {
    try {
      const invoicesCollection = fastify.mongo.db.collection("invoices");

      const invoices = await invoicesCollection
        .aggregate([
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
          { $sort: { invoiceId: -1 } },
        ])
        .toArray();

      return reply.send(invoices);
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch invoices" });
    }
  });

  // GET single invoice by invoiceId
  fastify.get("/invoice/:invoiceId", async (req, reply) => {
    try {
      let { invoiceId } = req.params;
      invoiceId = parseInt(invoiceId);
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
      let { invoiceId } = req.params;
      invoiceId = parseInt(invoiceId);

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
      let { invoiceId } = req.params;
      invoiceId = parseInt(invoiceId);

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
      let { invoiceId } = req.params;
      invoiceId = parseInt(invoiceId);

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
}

export default routes;
