import { serve } from "@hono/node-server";
import { fileSellerRecords } from "./agent/seller-records.js";
import { modelFromEnv } from "./agent/model.js";
import { evidenceDrivenDouble } from "./agent/test-double.js";
import { PayPalClient, loadPayPalConfig } from "./paypal/client.js";
import { createApp } from "./server.js";
import { Store } from "./store.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the process environment.
}

// Loopback and browser request-integrity checks are not operator authentication.
// Without a token a deliberate local client can approve/execute, so stay on loopback.
const operatorToken = process.env.DISPUTE_DESK_OPERATOR_TOKEN || undefined;
const hostname = operatorToken ? (process.env.HOST ?? "0.0.0.0") : "127.0.0.1";

const client = new PayPalClient(loadPayPalConfig());
const realModel = modelFromEnv();
const testDouble = !realModel && process.env.DISPUTE_DESK_TEST_DOUBLE === "1";
const model = realModel ?? (testDouble ? evidenceDrivenDouble() : undefined);
const app = createApp({
  client,
  store: new Store(process.env.DATABASE_PATH ?? "dispute-desk.sqlite"),
  model,
  testDouble,
  sellerRecords: fileSellerRecords(process.env.SELLER_RECORDS_DIR ?? "fixtures/seller-records"),
  webhookId: process.env.PAYPAL_WEBHOOK_ID,
  operatorToken,
});

const port = Number(process.env.PORT ?? 4000);
serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(operatorToken ? "Operator token required on /api" : "No operator token: listening on 127.0.0.1 only");
  console.log(`RebuttalForge API on http://localhost:${port}`);
  console.log(`PayPal base URL: ${client.baseUrl}${client.simulator ? " (SIMULATOR, not the real sandbox)" : ""}`);
  console.log(
    realModel
      ? "AI: configured"
      : testDouble
        ? "AI: SCRIPTED TEST DOUBLE (canned recommendations, no model is called)"
        : "AI not configured: cases will stop at evidence_gathered",
  );
  if (!process.env.PAYPAL_WEBHOOK_ID) console.warn("PAYPAL_WEBHOOK_ID is unset: /webhooks/paypal will answer 503");
});
