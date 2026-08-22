import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const scriptPath = path.resolve("scripts", "check-openai-plan-usage.mjs");
const snapshotPath = path.resolve("config", "openai-plan-usage.snapshot.json");

function run(arguments_: string[]): string {
  return execFileSync(process.execPath, [scriptPath, ...arguments_], { encoding: "utf8" });
}

describe("OpenAI plan usage snapshot", () => {
  it("fails closed when the checked-in snapshot lacks complete official-source coverage", () => {
    const result = JSON.parse(run(["--json"])) as Record<string, unknown>;
    expect(result).toMatchObject({
      status: "PASS",
      snapshotStatus: "STALE_FALLBACK",
      fallbackReason: "OFFICIAL_SOURCE_COVERAGE_INCOMPLETE",
      networkRequests: 0,
      docs: "PASS",
    });
  });

  it("hides point-in-time quantities immediately when official-source coverage is incomplete", () => {
    const output = run(["--skip-docs", "--render=en", "--now=2026-08-22"]);
    expect(output).toContain("STALE_FALLBACK");
    expect(output).toContain("could not be fully verified from current official sources");
    for (const unsupportedValue of ["160", "250–2000", "40000", "read-fetch-only"]) {
      expect(output).not.toContain(unsupportedValue);
    }
  });

  it("hides point-in-time quantities after 30 days", () => {
    const output = run(["--skip-docs", "--render=en", "--now=2026-10-01"]);
    expect(output).toContain("STALE_FALLBACK");
    expect(output).toContain("See current official limits");
    for (const currentValue of ["160", "250–2000", "40000", "read-fetch-only", "unlimited-subject-to-guardrails"]) {
      expect(output).not.toContain(currentValue);
    }
  });

  it("rejects a source outside the approved OpenAI domains", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "toolspan-usage-"));
    try {
      const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
        sources: Record<string, string>;
      };
      snapshot.sources.chatPricing = "https://example.invalid/plan-data";
      const candidate = path.join(directory, "snapshot.json");
      await writeFile(candidate, `${JSON.stringify(snapshot)}\n`, "utf8");
      const result = spawnSync(process.execPath, [
        scriptPath,
        `--snapshot=${candidate}`,
        "--skip-docs",
      ], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("approved OpenAI source domain");
      expect(result.stdout).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
