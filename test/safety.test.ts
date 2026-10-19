import { decisionFacts, snapshotForCase } from "../src/approval.js";
import { describe, expect, it } from "vitest";
import { executeApproved, type ExecutorClient } from "../src/agent/execute.js";
import { checkRecommendation } from "../src/agent/guard.js";
import { ScriptedModel, scriptedBranch } from "../src/agent/test-double.js";
import type { SellerRecord } from "../src/agent/seller-records.js";
import type { Case, Recommendation } from "../src/domain.js";
import { PayPalClient, type Exchange } from "../src/paypal/client.js";
import { openDispute, paidOrder, startSimulator } from "./support/sandbox.js";
import { buyerOpensDispute, sellOne, startSystem } from "./support/system.js";

const notShipped: SellerRecord = {
  kind: "not_shipped",
  label: "Seller fulfilment note",
  fact: "Item was out of stock and never shipped.",
  recordedAt: "2026-10-03T16:00:00Z",
};

describe("recorded exchanges", () => {
  it("never contain the OAuth access token", async () => {
    const exchanges: Exchange[] = [];
    const client = new PayPalClient(
      { baseUrl: "https://api-m.sandbox.paypal.com", clientId: "id", clientSecret: "secret" },
      {
        fetch: async (url) =>
          String(url).endsWith("/v1/oauth2/token")
            ? Response.json({ access_token: "A21-SECRET-TOKEN", token_type: "Bearer", expires_in: 3600 })
            : Response.json({ name: "RESOURCE_NOT_FOUND", message: "no" }, { status: 404 }),
        onExchange: (e) => exchanges.push(e),
      },
    );
    await client.getDispute("PP-D-1").catch(() => undefined);
    expect(exchanges.length).toBe(2);
    expect(JSON.stringify(exchanges)).not.toContain("A21-SECRET-TOKEN");
  });
});

describe("operator authentication", () => {
  it("rejects approve, execute, sandbox tools and case reads without the operator token", async () => {
    const sys = startSystem({ model: scriptedBranch("concede"), operatorToken: "op-secret" });
    const { captureId } = await sellOne(sys, "auth");
    sys.records[captureId] = [notShipped];
    const { disputeId } = await buyerOpensDispute(sys, captureId);

    for (const [method, path, body] of [
      ["POST", `/api/cases/${disputeId}/approve`, { approvedBy: "anyone", recommendationRevision: sys.store.getCase(disputeId)?.recommendationRevision }],
      ["POST", `/api/cases/${disputeId}/execute`, undefined],
      ["POST", `/api/cases/${disputeId}/reassess`, undefined],
      ["POST", `/api/sandbox/disputes/${disputeId}/adjudicate`, { outcome: "SELLER_FAVOR" }],
      ["GET", `/api/cases/${disputeId}`, undefined],
    ] as const) {
      expect((await sys.api(method, path, body)).status, `${method} ${path}`).toBe(401);
      expect((await sys.api(method, path, body, { authorization: "Bearer wrong" })).status).toBe(401);
    }
    expect(sys.fetchCalls.some((c) => c.includes("accept-claim") || c.includes("adjudicate"))).toBe(false);

    const auth = { authorization: "Bearer op-secret" };
    expect((await sys.api("POST", `/api/cases/${disputeId}/approve`, { approvedBy: "Seller", recommendationRevision: sys.store.getCase(disputeId)?.recommendationRevision }, auth)).status).toBe(200);
    expect((await sys.api("GET", "/api/health")).status).toBe(200);
  });
});

describe("execution record", () => {
  it("survives a failed re-fetch after PayPal accepted the action", async () => {
    const sb = startSimulator();
    const { captureId } = await paidOrder(sb);
    const { dispute_id } = await openDispute(sb, captureId);
    let gets = 0;
    const flaky: ExecutorClient = {
      getDispute: async (id) => {
        if (++gets === 2) throw new TypeError("simulated network failure");
        return sb.client.getDispute(id);
      },
      provideEvidence: (...a) => sb.client.provideEvidence(...a),
      makeOffer: (...a) => sb.client.makeOffer(...a),
      acceptClaim: (...a) => sb.client.acceptClaim(...a),
    };
    const recommendation: Recommendation = {
      action: "concede",
      confidence: "high",
      summary: "s",
      supports: [],
      contradicts: [],
      draft: { note: "n" },
    };
    const approved: Case = {
      disputeId: dispute_id,
      status: "approved",
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      amount: { currency_code: "USD", value: "48.00" },
      permittedRels: [],
      evidence: [],
      assessment: { kind: "actionable", recommendation },
      guardFailures: [],
      approvedBy: "seller",
      updatedAt: "2026-10-09T00:00:00Z",
    };

    const reviewedDispute = await sb.client.getDispute(dispute_id);
    approved.sellerResponseDueDate = reviewedDispute.seller_response_due_date;
    approved.recommendationRevision = "reviewed-version";
    approved.decisionFacts = decisionFacts(reviewedDispute);
    approved.approvedSnapshot = snapshotForCase(approved);
    const result = await executeApproved(approved, flaky);
    expect(result.execution).toMatchObject({ action: "concede", httpStatus: 200 });
    expect(result.after).toBeUndefined();
    expect((await sb.client.getDispute(dispute_id)).status).toBe("RESOLVED");
  });

  it("marks the case failed with an unknown outcome when the action call itself dies, and does not retry blindly", async () => {
    const sys = startSystem({ model: scriptedBranch("concede") });
    const { captureId } = await sellOne(sys, "unk");
    sys.records[captureId] = [notShipped];
    const { disputeId } = await buyerOpensDispute(sys, captureId);
    await sys.api("POST", `/api/cases/${disputeId}/approve`, { approvedBy: "Seller", recommendationRevision: sys.store.getCase(disputeId)?.recommendationRevision });

    sys.failures.when = (call) => call.startsWith("POST") && call.endsWith("/accept-claim");
    const res = await sys.api("POST", `/api/cases/${disputeId}/execute`);
    expect(res.status).toBe(502);
    sys.failures.when = undefined;

    const { body: c } = await sys.api("GET", `/api/cases/${disputeId}`);
    expect(c.status).toBe("failed");
    expect(c.error).toMatch(/outcome is unknown/i);
    const again = await sys.api("POST", `/api/cases/${disputeId}/execute`);
    expect(again.status).toBe(409);
    expect(sys.fetchCalls.filter((x) => x.endsWith("/accept-claim")).length).toBe(1);
  });
});

describe("reassessment", () => {
  it("drops the previous recommendation when the model fails, so stale advice cannot be approved", async () => {
    let fail = false;
    const concede = scriptedBranch("concede");
    const model = new ScriptedModel((input) => {
      if (fail) throw new Error("model unavailable");
      return concede.recommend(input);
    });
    const sys = startSystem({ model });
    const { captureId } = await sellOne(sys, "stale");
    sys.records[captureId] = [notShipped];
    const { disputeId } = await buyerOpensDispute(sys, captureId);
    expect((await sys.api("GET", `/api/cases/${disputeId}`)).body.assessment?.recommendation.action).toBe("concede");

    fail = true;
    sys.records[captureId] = [{ ...notShipped, fact: "Correction: the item shipped on 2026-10-02." }];
    const { body: c } = await sys.api("POST", `/api/cases/${disputeId}/reassess`);
    expect(c.assessment?.recommendation).toBeUndefined();
    expect(c.status).toBe("evidence_gathered");
    expect(c.error).toMatch(/model unavailable/);
    expect((await sys.api("POST", `/api/cases/${disputeId}/approve`, { approvedBy: "Seller", recommendationRevision: sys.store.getCase(disputeId)?.recommendationRevision })).status).toBe(409);
  });
});

describe("guard", () => {
  it("rejects a recommendation that states no supporting claim", () => {
    const rec: Recommendation = {
      action: "concede",
      confidence: "high",
      summary: "s",
      supports: [],
      contradicts: [],
      draft: { note: "The buyer admitted fraud." },
    };
    expect(
      checkRecommendation(rec, [], ["accept_claim"], { currency_code: "USD", value: "1.00" }, undefined, new Date()).map((f) => f.code),
    ).toEqual(["NO_SUPPORTING_CLAIM"]);
  });
});

describe("rate limiting", () => {
  const token = () => Response.json({ access_token: "t", token_type: "Bearer", expires_in: 3600 });
  const limited = (retryAfter?: string) =>
    Response.json({ name: "RATE_LIMIT_REACHED", message: "Too many requests" }, { status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : {} });

  it("waits for Retry-After on a 429 and retries, without fetching a new token", async () => {
    const waits: number[] = [];
    const calls: string[] = [];
    let disputeCalls = 0;
    const client = new PayPalClient(
      { baseUrl: "https://api-m.sandbox.paypal.com", clientId: "id", clientSecret: "secret" },
      {
        fetch: async (url) => {
          const path = new URL(String(url)).pathname;
          calls.push(path);
          if (path === "/v1/oauth2/token") return token();
          return ++disputeCalls === 1 ? limited("7") : Response.json({ name: "RESOURCE_NOT_FOUND", message: "no" }, { status: 404 });
        },
        sleep: async (ms) => void waits.push(ms),
      },
    );
    const err = await client.getDispute("PP-D-1").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 404 });
    expect(waits).toEqual([7000]);
    expect(calls.filter((c) => c === "/v1/oauth2/token").length).toBe(1);
  });

  it("gives up after three limited attempts and surfaces the 429", async () => {
    const waits: number[] = [];
    const client = new PayPalClient(
      { baseUrl: "https://api-m.sandbox.paypal.com", clientId: "id", clientSecret: "secret" },
      {
        fetch: async (url) => (String(url).endsWith("/v1/oauth2/token") ? token() : limited()),
        sleep: async (ms) => void waits.push(ms),
      },
    );
    const err = await client.getDispute("PP-D-1").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429 });
    expect(waits).toEqual([30000, 30000]);
  });

  it("does not retry early when PayPal asks for a longer wait than the client allows", async () => {
    const waits: number[] = [];
    let disputeCalls = 0;
    const client = new PayPalClient(
      { baseUrl: "https://api-m.sandbox.paypal.com", clientId: "id", clientSecret: "secret" },
      {
        fetch: async (url) => {
          if (String(url).endsWith("/v1/oauth2/token")) return token();
          disputeCalls++;
          return limited("600");
        },
        sleep: async (ms) => void waits.push(ms),
      },
    );
    const err = await client.getDispute("PP-D-1").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429 });
    expect(waits).toEqual([]);
    expect(disputeCalls).toBe(1);
  });

  it("records every attempt, including the limited ones, so usage can be counted", async () => {
    const exchanges: Exchange[] = [];
    let disputeCalls = 0;
    const client = new PayPalClient(
      { baseUrl: "https://api-m.sandbox.paypal.com", clientId: "id", clientSecret: "secret" },
      {
        fetch: async (url) => {
          if (String(url).endsWith("/v1/oauth2/token")) return token();
          return ++disputeCalls === 1 ? limited("1") : Response.json({ name: "RESOURCE_NOT_FOUND", message: "no" }, { status: 404 });
        },
        sleep: async () => undefined,
        onExchange: (e) => exchanges.push(e),
      },
    );
    await client.getDispute("PP-D-1").catch(() => undefined);
    expect(exchanges.map((e) => e.status)).toEqual([200, 429, 404]);
  });
});

describe("webhook redelivery", () => {
  it("does not spend a PayPal verification call on an event already processed", async () => {
    const sys = startSystem({ model: scriptedBranch("concede") });
    const { captureId } = await sellOne(sys, "dup");
    sys.records[captureId] = [notShipped];
    const { eventId } = await buyerOpensDispute(sys, captureId);
    const verifies = () => sys.fetchCalls.filter((c) => c.endsWith("/verify-webhook-signature")).length;
    const before = verifies();

    for (let i = 0; i < 3; i++) {
      expect((await sys.simPost(`/_sim/webhooks/redeliver/${eventId}`)).body.listener_status).toBe(200);
    }
    expect(verifies()).toBe(before);
  });
});
