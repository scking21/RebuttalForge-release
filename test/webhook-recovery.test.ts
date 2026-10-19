import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { scriptedBranch } from "../src/agent/test-double.js";
import { createApp } from "../src/server.js";
import { buyerOpensDispute, sellOne, startSystem } from "./support/system.js";

const headers = {
  "content-type": "application/json", "paypal-transmission-id": "synthetic",
  "paypal-transmission-time": "2026-10-11T00:00:00Z", "paypal-transmission-sig": "synthetic",
  "paypal-cert-url": "https://example.test/cert", "paypal-auth-algo": "SHA256withRSA",
};
const event = (id: string, disputeId: string, type = "CUSTOMER.DISPUTE.UPDATED") => ({
  id, event_type: type, resource: { dispute_id: disputeId },
});
async function setup() {
  const model = scriptedBranch("concede");
  const sys = startSystem({ model });
  const { captureId } = await sellOne(sys, "webhook-recovery");
  sys.records[captureId] = [{ kind: "not_shipped", label: "Synthetic seller statement", fact: "Never shipped", recordedAt: "2026-10-01T00:00:00Z" }];
  const { disputeId } = await buyerOpensDispute(sys, captureId);
  vi.spyOn(sys.client, "verifyWebhookSignature").mockResolvedValue(true);
  const send = (id: string, type?: string) => sys.server.request("/webhooks/paypal", { method: "POST", headers, body: JSON.stringify(event(id, disputeId, type)) });
  return { ...sys, model, disputeId, send };
}

describe("webhook crash recovery", () => {
  it("retries an event after a child process exits immediately after the durable claim", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dispute-webhook-crash-"));
    const database = join(directory, "crash.sqlite");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    const compile = spawnSync(process.execPath, [
      fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
      "--ignoreConfig", "--target", "ES2022", "--module", "NodeNext", "--skipLibCheck", "--types", "node",
      "--outDir", directory, "src/store.ts", "src/domain.ts",
    ], { encoding: "utf8" });
    expect(compile.status, compile.stdout + compile.stderr).toBe(0);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { Store } from ${JSON.stringify(join(directory, "store.js"))};
      const store = new Store(${JSON.stringify(database)});
      if (store.startWebhook) store.startWebhook("WH-CRASH"); else store.claimWebhook("WH-CRASH");
      process.exit(73);
    `], { encoding: "utf8" });
    expect(child.status, child.stderr).toBe(73);
    const store = new Store(database);
    try {
      expect(store.hasWebhook("WH-CRASH")).toBe(false);
      const sys = await setup();
      const app = createApp({ client: sys.client, store, model: sys.model, sellerRecords: id => sys.records[id] ?? [], webhookId: "WH-TEST" });
      const send = () => app.request("/webhooks/paypal", { method: "POST", headers, body: JSON.stringify(event("WH-CRASH", sys.disputeId)) });
      expect((await send()).status).toBe(200);
      expect(store.getCase(sys.disputeId)?.status).toBe("recommended");
      expect(store.hasWebhook("WH-CRASH")).toBe(true);
      const calls = sys.model.calls.length;
      expect(await (await send()).json()).toEqual({ duplicate: true });
      expect(sys.model.calls).toHaveLength(calls);
    } finally { store.close(); }
    const reopened = new Store(database);
    try { expect(reopened.hasWebhook("WH-CRASH")).toBe(true); } finally { reopened.close(); }
  });

  it("does not acknowledge an in-flight duplicate before processing finishes", async () => {
    const sys = await setup();
    let start!: () => void;
    let finish!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const recommend = sys.model.recommend.bind(sys.model);
    vi.spyOn(sys.model, "recommend").mockImplementation(async input => {
      start();
      await finished;
      return recommend(input);
    });
    const first = sys.send("WH-CONCURRENT");
    await started;
    const second = Promise.resolve(sys.send("WH-CONCURRENT"));
    const observation = await Promise.race([second.then(() => "acknowledged"), new Promise(resolve => setTimeout(() => resolve("waiting"), 25))]);
    finish();
    expect(observation).toBe("waiting");
    expect((await first).status).toBe(200);
    expect(await (await second).json()).toEqual({ duplicate: true });
    expect(sys.model.recommend).toHaveBeenCalledTimes(1);
  });

  it.each(["nonresolved", "wrong identity"])("keeps a resolved notification retryable for %s fresh details", async fault => {
    const sys = await setup();
    if (fault === "wrong identity") {
      const read = sys.client.getDispute.bind(sys.client);
      vi.spyOn(sys.client, "getDispute").mockImplementation(async id => ({ ...await read(id), dispute_id: "OTHER", status: "RESOLVED" }));
    }
    expect((await sys.send("WH-RESOLUTION", "CUSTOMER.DISPUTE.RESOLVED")).status).toBe(500);
    expect(sys.store.getCase(sys.disputeId)?.status).not.toBe("resolved");
    expect(sys.store.hasWebhook("WH-RESOLUTION")).toBe(false);
  });
});


describe("webhook completion boundaries", () => {
  it("migrates legacy claims as unfinished rather than assuming successful processing", () => {
    const directory = mkdtempSync(join(tmpdir(), "dispute-webhook-legacy-"));
    const database = join(directory, "legacy.sqlite");
    const old = new DatabaseSync(database);
    old.exec("CREATE TABLE webhook_events (event_id TEXT PRIMARY KEY, received_at TEXT NOT NULL)");
    old.prepare("INSERT INTO webhook_events VALUES (?, ?)").run("WH-OLD", "2026-10-10T00:00:00Z");
    old.close();
    const store = new Store(database);
    try {
      expect(store.hasWebhook("WH-OLD")).toBe(false);
      store.startWebhook("WH-OLD");
      store.completeWebhook("WH-OLD");
      expect(store.hasWebhook("WH-OLD")).toBe(true);
    } finally { store.close(); }
  });

  it("retries processing that finished before the completion marker failed", async () => {
    const sys = await setup();
    const complete = sys.store.completeWebhook.bind(sys.store);
    vi.spyOn(sys.store, "completeWebhook").mockImplementationOnce(() => { throw new Error("simulated crash boundary before completion"); });
    expect((await sys.send("WH-COMMIT-GAP")).status).toBe(500);
    expect(sys.store.hasWebhook("WH-COMMIT-GAP")).toBe(false);
    expect(sys.store.getCase(sys.disputeId)?.status).toBe("recommended");
    vi.mocked(sys.store.completeWebhook).mockImplementation(complete);
    expect((await sys.send("WH-COMMIT-GAP")).status).toBe(200);
    expect(sys.store.hasWebhook("WH-COMMIT-GAP")).toBe(true);
    expect(sys.store.getCase(sys.disputeId)?.status).toBe("recommended");
    expect(sys.sim.state.actionLog).toEqual([]);
  });

  it("accepts a previously inconsistent resolution only after fresh state confirms it", async () => {
    const sys = await setup();
    expect((await sys.send("WH-LATE-RESOLUTION", "CUSTOMER.DISPUTE.RESOLVED")).status).toBe(500);
    sys.sim.setWebhookUrl(undefined);
    await sys.client.acceptClaim(sys.disputeId, { note: "synthetic" }, "resolution-fixture");
    expect((await sys.send("WH-LATE-RESOLUTION", "CUSTOMER.DISPUTE.RESOLVED")).status).toBe(200);
    expect(sys.store.getCase(sys.disputeId)?.status).toBe("resolved");
    expect(sys.store.hasWebhook("WH-LATE-RESOLUTION")).toBe(true);
  });
});
