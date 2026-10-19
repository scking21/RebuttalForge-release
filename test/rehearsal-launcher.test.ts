import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("documented Node loader launch commands", () => {
  for (const [name, entry] of Object.entries({
    dev: "src/main.ts",
    simulator: "src/simulator/main.ts",
    rehearsal: "scripts/rehearsal.ts",
    "seed:simulator": "scripts/seed-simulator.ts",
  })) {
    it(`${name} does not require the tsx CLI IPC server`, () => {
      expect(pkg.scripts[name]).toBe(`node --import tsx ${entry}`);
    });
  }
  it("provides an explicit credential-free simulator rehearsal", () => {
    expect(pkg.scripts["rehearsal:simulator"]).toBe("node --import tsx scripts/rehearsal.ts --simulator");
  });
});
