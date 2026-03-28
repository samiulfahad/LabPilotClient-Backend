// plugins/sms.js
import axios from "axios";
import fp from "fastify-plugin";

async function smsPlugin(fastify) {
  const formatBDPhone = (phone) => `880${phone.replace(/^0/, "")}`;

  fastify.decorate("sendSMS", async ({ number, message }) => {
    const response = await axios.get("http://bulksmsbd.net/api/smsapi", {
      params: {
        api_key: process.env.BULKSMS_API_KEY,
        senderid: process.env.BULKSMS_SENDER_ID,
        type: "text",
        number: formatBDPhone(number),
        message,
      },
    });
    return response.data;
  });
}

export default fp(smsPlugin);
