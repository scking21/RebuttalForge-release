// @vitest-environment jsdom
// Actual UI transport -> in-process Hono -> simulator. No ports or external requests.
import { afterEach, expect, it, vi } from "vitest";
import { scriptedBranch } from "../../src/agent/test-double";
import { buyerOpensDispute, sellOne, startSystem, type System } from "../../test/support/system";
import { api } from "../src/api";

let sys: System | undefined;
afterEach(() => {
  sys?.store.close();
  sys = undefined;
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it("sends the integrity marker on actual UI approval and bodyless execution without bypassing approval", async () => {
  sys = startSystem({ model: scriptedBranch("concede") });
  const { captureId } = await sellOne(sys, "ui-request-integrity");
  sys.records[captureId] = [{ kind: "not_shipped", label: "Synthetic seller note", fact: "Item was out of stock and never shipped.", recordedAt: "2026-10-18T00:00:00Z" }];
  const { disputeId } = await buyerOpensDispute(sys, captureId);
  const requests: Array<{ path: string; headers: Headers; body: unknown }> = [];
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    headers.set("origin", "http://127.0.0.1:5173");
    headers.set("sec-fetch-site", "same-origin");
    requests.push({ path, headers, body: init.body });
    return sys!.server.request(path, { ...init, headers });
  });
  sys.fetchCalls.length = 0;
  await expect(api.execute(disputeId)).rejects.toMatchObject({ status: 409 });
  expect(sys.fetchCalls).toEqual([]);
  await api.approve(disputeId, "Synthetic operator", sys.store.getCase(disputeId)!.recommendationRevision!);
  expect(sys.fetchCalls).toEqual([]);
  const executed = await api.execute(disputeId);
  expect(executed.status).toBe("resolved");
  expect(sys.fetchCalls.filter(call => call.endsWith("/accept-claim"))).toHaveLength(1);
  expect(requests).toHaveLength(3);
  expect(requests.every(request => request.headers.get("x-rebuttalforge-request") === "operator")).toBe(true);
  expect(requests[2]?.body).toBeUndefined();
});
