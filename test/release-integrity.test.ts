import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const write = (root: string, path: string, text: string) => { const file = join(root, path); mkdirSync(resolve(file, ".."), { recursive: true }); writeFileSync(file, text); };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "current-build-integrity-")); temporary.push(dir);
  for (const file of ["package.json", "package-lock.json", "tsconfig.json", "web/package.json", "web/package-lock.json", "web/tsconfig.json", "web/vite.config.ts", "scripts/current-build.mjs", "scripts/check-third-party-notices.mjs", "verification/third-party-notices.json"]) write(dir, file, "{}");
  write(dir, "src/main.ts", "// synthetic backend input");
  write(dir, "web/src/main.tsx", "// synthetic frontend input");
  write(dir, "web/index.html", '<div id="root"></div>');
  write(dir, "web/public/THIRD-PARTY-NOTICES.txt", "Synthetic upstream notice");
  write(dir, "web/dist/index.html", '<script src="/assets/index-SYNTHETIC.js"></script>');
  write(dir, "web/dist/assets/index-SYNTHETIC.js", "// synthetic bundle");
  write(dir, "web/dist/THIRD-PARTY-NOTICES.txt", "Synthetic upstream notice");
  return dir;
}
function command(mode: string, dir: string) {
  const result = spawnSync(process.execPath, [join(root, "scripts/current-build.mjs"), mode, dir], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function recorded() {
  const dir = fixture();
  expect(command("record", dir)).toMatchObject({ status: 0 });
  return dir;
}

describe("current-build evidence is pinned and independently checkable", () => {
  it("preserves the historical video contract and its independent failing comparison", () => {
    expect(hash(readFileSync(join(root, "verification/recorded-preview-contract.json")))).toBe("4827eaeedfdba4bf79ae4ec4550ffa45fc099a483cf2a188b19322537b3f3f71");
    expect(hash(readFileSync(join(root, "scripts/check-preview-correspondence.mjs")))).toBe("9e3f5341b5732fdb67d7d06f0b7496d37c39ae2a2942ef7e0233a05a868ff44e");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts.verify).toBe("npm run verify:local && npm run verify:preview");
    expect(pkg.scripts["verify:local"]).not.toContain("record:current-preview");
  });
  it("records explicit local evidence and verifies it without changing the manifest or claiming video/live proof", () => {
    const dir = recorded();
    const manifest = join(dir, "verification/current-build-manifest.json");
    const before = readFileSync(manifest);
    const result = command("check", dir);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "PASS", historicalVideoCorrespondence: "UNVERIFIED", liveProviderVerification: "UNVERIFIED" });
    expect(readFileSync(manifest)).toEqual(before);
  });
  it.each(["changed-asset", "missing-asset", "extra-asset", "changed-source", "changed-notice", "missing-notice", "modified-manifest", "missing-manifest"])("fails closed for %s", mode => {
    const dir = recorded();
    if (mode === "changed-asset") write(dir, "web/dist/assets/index-SYNTHETIC.js", "tampered");
    if (mode === "missing-asset") rmSync(join(dir, "web/dist/assets/index-SYNTHETIC.js"));
    if (mode === "extra-asset") write(dir, "web/dist/assets/unexpected.js", "extra");
    if (mode === "changed-source") write(dir, "src/main.ts", "changed input");
    if (mode === "changed-notice") write(dir, "web/dist/THIRD-PARTY-NOTICES.txt", "altered notice");
    if (mode === "missing-notice") rmSync(join(dir, "web/dist/THIRD-PARTY-NOTICES.txt"));
    if (mode === "modified-manifest") { const p = join(dir, "verification/current-build-manifest.json"); const data = JSON.parse(readFileSync(p, "utf8")); data.build[0].sha256 = "0".repeat(64); writeFileSync(p, JSON.stringify(data)); }
    if (mode === "missing-manifest") rmSync(join(dir, "verification/current-build-manifest.json"));
    const result = command("check", dir);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "FAIL" });
  });
});

describe("distributed third-party notices", () => {
  it("ships exact installed locked UI runtime license texts and a readable notices link", () => {
    const manifestPath = join(root, "verification/third-party-notices.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const names = manifest.packages.map((entry: { name: string }) => entry.name);
    for (const name of ["@fontsource-variable/atkinson-hyperlegible-next", "@fontsource/atkinson-hyperlegible-mono", "react", "react-dom", "ag-grid-community", "ag-grid-react", "scheduler", "ag-stack"]) expect(names).toContain(name);
    const lock = JSON.parse(readFileSync(join(root, "web/package-lock.json"), "utf8"));
    const index = readFileSync(join(root, "web/public/THIRD-PARTY-NOTICES.txt"), "utf8");
    for (const entry of manifest.packages) {
      const upstream = readFileSync(join(root, "web/node_modules", entry.name, entry.upstreamFile));
      expect(hash(upstream)).toBe(entry.sha256);
      expect(readFileSync(join(root, "web/public", entry.distributedFile))).toEqual(upstream);
      expect(index).toContain(upstream.toString("utf8"));
      expect(lock.packages[`node_modules/${entry.name}`].version).toBe(entry.version);
    }
    expect(readFileSync(join(root, "web/index.html"), "utf8")).toContain('href="/THIRD-PARTY-NOTICES.txt"');
  });
});
