import { afterEach, describe, expect, it, vi } from "vitest";
import { scriptedBranch } from "../src/agent/test-double.js";
import { PayPalClient } from "../src/paypal/client.js";
import { createApp } from "../src/server.js";
import { Store } from "../src/store.js";
import { buyerOpensDispute, sellOne, startSystem, type System } from "./support/system.js";

const requestMarker = { "x-rebuttalforge-request": "operator" };
const trustedBrowser = { ...requestMarker, origin: "http://localhost:5173", "sec-fetch-site": "same-origin" };
const missingMarkerHeaders: Record<string, string>[] = [{}, { origin: "http://localhost:5173" }, { "content-type": "application/json" }, { "content-type": "text/plain" }, { "x-rebuttalforge-request": "wrong" }];
const systems: System[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const sys of systems.splice(0)) sys.store.close();
  for (const store of stores.splice(0)) store.close();
  vi.unstubAllGlobals();
});

async function readyCase(approved = true, operatorToken?: string) {
  // All provider traffic is the injected in-process simulator. Any accidental network fetch fails.
  vi.stubGlobal("fetch", () => { throw new Error("External requests prohibited in request-integrity tests"); });
  const sys = startSystem({ model: scriptedBranch("concede"), operatorToken });
  systems.push(sys);
  const { captureId } = await sellOne(sys, "request-integrity");
  sys.records[captureId] = [{ kind: "not_shipped", label: "Synthetic seller note", fact: "Item was out of stock and never shipped.", recordedAt: "2026-10-18T00:00:00Z" }];
  const { disputeId } = await buyerOpensDispute(sys, captureId);
  if (approved) {
    const response = await sys.api("POST", `/api/cases/${disputeId}/approve`, {
      approvedBy: "Synthetic operator", recommendationRevision: sys.store.getCase(disputeId)?.recommendationRevision,
    }, operatorToken ? { authorization: `Bearer ${operatorToken}` } : {});
    expect(response.status).toBe(200);
  }
  sys.fetchCalls.length = 0;
  return { sys, disputeId };
}

function unchanged(sys: System, disputeId: string) {
  return { case: sys.store.getCase(disputeId), audit: sys.store.auditTrail(disputeId) };
}

describe("API mutation request integrity", () => {
  it("rejects the reproduced simple cross-site execute POST without touching the approved case or provider", async () => {
    const { sys, disputeId } = await readyCase();
    const before = unchanged(sys, disputeId);
    const response = await sys.server.request(`/api/cases/${disputeId}/execute`, {
      method: "POST", headers: { origin: "https://unrelated.example", "sec-fetch-site": "cross-site", "content-type": "text/plain" }, body: "",
    });
    expect(response.status).toBe(403);
    expect(sys.fetchCalls).toEqual([]);
    expect(unchanged(sys, disputeId)).toEqual(before);
    expect(sys.store.getCase(disputeId)?.status).toBe("approved");
  });

  it.each([
    ["reassess", undefined],
    ["approve", { approvedBy: "Untrusted", recommendationRevision: "unused" }],
    ["execute", undefined],
    ["require-evidence", {}],
    ["adjudicate", { outcome: "BUYER_FAVOR" }],
    ["catalog", { query: "ceramic set" }],
  ] as const)("rejects an untrusted Origin on %s even with the request marker", async (action, body) => {
    const { sys, disputeId } = await readyCase();
    const before = unchanged(sys, disputeId);
    const path = action === "catalog" ? "/api/catalog/search" : ["require-evidence", "adjudicate"].includes(action)
      ? `/api/sandbox/disputes/${disputeId}/${action}` : `/api/cases/${disputeId}/${action}`;
    const response = await sys.server.request(path, {
      method: "POST", headers: { ...requestMarker, origin: "https://unrelated.example", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "untrusted_origin" });
    expect(sys.fetchCalls).toEqual([]);
    expect(unchanged(sys, disputeId)).toEqual(before);
  });

  it.each(missingMarkerHeaders)(
    "requires the non-simple marker for a mutation with headers %j", async headers => {
      const { sys, disputeId } = await readyCase();
      const response = await sys.server.request(`/api/cases/${disputeId}/execute`, { method: "POST", headers });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "request_integrity_required" });
      expect(sys.fetchCalls).toEqual([]);
      expect(sys.store.getCase(disputeId)?.status).toBe("approved");
    },
  );

  it.each(["null", "http://localhost:5174", "http://localhost:5173.evil.test", "https://localhost:5173", "http://localhost:5173/", "not an origin", "http://localhost:5173, https://unrelated.example"])(
    "rejects an opaque, malformed or non-exact Origin: %s", async origin => {
      const { sys, disputeId } = await readyCase();
      const response = await sys.server.request(`/api/cases/${disputeId}/execute`, { method: "POST", headers: { ...requestMarker, origin } });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "untrusted_origin" });
      expect(sys.fetchCalls).toEqual([]);
    },
  );

  it("rejects an Origin-less cross-site request even with a marker", async () => {
    const { sys, disputeId } = await readyCase();
    const response = await sys.server.request(`/api/cases/${disputeId}/execute`, { method: "POST", headers: { ...requestMarker, "sec-fetch-site": "cross-site" } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "untrusted_origin" });
    expect(sys.fetchCalls).toEqual([]);
  });

  it("keeps deliberate browser approval and execution separate, with exactly one provider action", async () => {
    const { sys, disputeId } = await readyCase(false);
    const execute = () => sys.server.request(`/api/cases/${disputeId}/execute`, { method: "POST", headers: trustedBrowser });
    expect((await execute()).status).toBe(409);
    expect(sys.fetchCalls).toEqual([]);
    const approved = await sys.api("POST", `/api/cases/${disputeId}/approve`, {
      approvedBy: "Synthetic operator", recommendationRevision: sys.store.getCase(disputeId)?.recommendationRevision,
    }, trustedBrowser);
    expect(approved.status).toBe(200);
    expect(sys.fetchCalls).toEqual([]);
    expect((await execute()).status).toBe(200);
    expect((await execute()).status).toBe(200);
    expect(sys.store.getCase(disputeId)?.status).toBe("resolved");
    expect(sys.fetchCalls.filter(call => call.endsWith("/accept-claim"))).toHaveLength(1);
  });

  it("allows deliberate non-browser requests with the marker and no browser headers", async () => {
    const { sys, disputeId } = await readyCase();
    const response = await sys.server.request(`/api/cases/${disputeId}/execute`, { method: "POST", headers: requestMarker });
    expect(response.status).toBe(200);
    expect(sys.fetchCalls.filter(call => call.endsWith("/accept-claim"))).toHaveLength(1);
  });

  it("supports the documented 127.0.0.1 frontend alias with the same exact-port restriction", async () => {
    const { sys, disputeId } = await readyCase();
    const response = await sys.server.request(`/api/cases/${disputeId}/execute`, { method: "POST", headers: { ...requestMarker, origin: "http://127.0.0.1:5173" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    expect(sys.fetchCalls.filter(call => call.endsWith("/accept-claim"))).toHaveLength(1);
  });

  it("never treats a request marker as operator authentication", async () => {
    const { sys, disputeId } = await readyCase(true, "synthetic-secret");
    for (const authorization of [undefined, "Bearer wrong"]) {
      const response = await sys.server.request(`/api/cases/${disputeId}/execute`, { method: "POST", headers: { ...trustedBrowser, ...(authorization ? { authorization } : {}) } });
      expect(response.status).toBe(401);
    }
    expect(sys.fetchCalls).toEqual([]);
    const response = await sys.server.request(`/api/cases/${disputeId}/execute`, { method: "POST", headers: { ...trustedBrowser, authorization: "Bearer synthetic-secret" } });
    expect(response.status).toBe(200);
  });

  it("rejects an untrusted Origin even with a valid operator token", async () => {
    const { sys, disputeId } = await readyCase(true, "synthetic-secret");
    const response = await sys.server.request(`/api/cases/${disputeId}/execute`, { method: "POST", headers: { ...requestMarker, origin: "https://unrelated.example", authorization: "Bearer synthetic-secret" } });
    expect(response.status).toBe(403);
    expect(sys.fetchCalls).toEqual([]);
  });

  it("does not infer a trusted browser Origin from an attacker-controlled request URL or forwarded headers", async () => {
    const { sys, disputeId } = await readyCase();
    const response = await sys.server.request(`http://attacker.example/api/cases/${disputeId}/execute`, { method: "POST", headers: {
      ...requestMarker, origin: "http://attacker.example", "x-forwarded-host": "localhost:5173", "x-forwarded-proto": "http",
    } });
    expect(response.status).toBe(403);
    expect(sys.fetchCalls).toEqual([]);
  });
});

describe("trusted browser configuration and read-only requests", () => {
  function app(corsOrigin?: string, operatorToken?: string) {
    const store = new Store();
    stores.push(store);
    const searches: string[] = [];
    const client = new PayPalClient({ baseUrl: "http://localhost:4010", clientId: "synthetic", clientSecret: "synthetic" }, { fetch: async () => { throw new Error("Unexpected provider request"); } });
    return { searches, app: createApp({ client, store, sellerRecords: () => [], corsOrigin, operatorToken,
      catalog: { search: async query => { searches.push(query); return { products: [], retrievedAt: "2026-10-18T00:00:00Z" }; } },
    }) };
  }

  it.each(["*", "null", "https://trusted.example/path", "https://user:secret@trusted.example", "https://trusted.example/", "not an origin"])(
    "fails closed for an unsafe browser-Origin configuration: %s", origin => {
      expect(() => app(origin)).toThrow(/origin/i);
    },
  );

  it("uses the configured exact Origin for authenticated catalog requests and CORS preflight", async () => {
    const { app: server, searches } = app("https://trusted.example", "synthetic-secret");
    const headers = { ...requestMarker, origin: "https://trusted.example", "sec-fetch-site": "cross-site", authorization: "Bearer synthetic-secret", "content-type": "application/json" };
    const response = await server.request("/api/catalog/search", { method: "POST", headers, body: JSON.stringify({ query: "ceramic set" }) });
    expect(response.status).toBe(200);
    expect(searches).toEqual(["ceramic set"]);
    const preflight = await server.request("/api/catalog/search", { method: "OPTIONS", headers: {
      origin: "https://trusted.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,x-rebuttalforge-request",
    } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://trusted.example");
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-rebuttalforge-request");
    const rejected = await server.request("/api/catalog/search", { method: "POST", headers: { ...headers, origin: "http://localhost:5173" }, body: JSON.stringify({ query: "ceramic set" }) });
    expect(rejected.status).toBe(403);
    expect(searches).toEqual(["ceramic set"]);
  });

  it("keeps health and case reads marker-free, while case reads still need configured authentication", async () => {
    const { app: server } = app(undefined, "synthetic-secret");
    expect((await server.request("/api/health")).status).toBe(200);
    expect((await server.request("/api/cases")).status).toBe(401);
    expect((await server.request("/api/cases", { headers: { authorization: "Bearer synthetic-secret" } })).status).toBe(200);
  });
});
