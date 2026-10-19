import { serve } from "@hono/node-server";
import { createSimulator } from "./app.js";

const port = Number(process.env.SIM_PORT ?? 4010);
const sim = createSimulator({
  baseUrl: `http://localhost:${port}`,
  webhookUrl: process.env.SIM_WEBHOOK_URL ?? "http://localhost:4000/webhooks/paypal",
});

serve({ fetch: sim.app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`PayPal SIMULATOR (not the real sandbox) listening on http://localhost:${port}`);
  console.log(`Set PAYPAL_BASE_URL=http://localhost:${port}. Webhooks go to ${process.env.SIM_WEBHOOK_URL ?? "http://localhost:4000/webhooks/paypal"}`);
});
