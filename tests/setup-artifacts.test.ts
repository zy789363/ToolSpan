import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const safeEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/(?:secret|password|token|api.?key|private.?key|credential|cloudflare)/iu.test(name)));

async function runScript(name: string, arguments_: string[] = []) {
  const result = await execute(process.execPath, [path.resolve("scripts", name), ...arguments_], {
    cwd: process.cwd(),
    env: safeEnvironment,
    windowsHide: true,
  });
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

describe("Setup packaged documentation gates", () => {
  it("hides NameSilo price and coupon claims when official coverage is incomplete", async () => {
    const result = await runScript("check-commercial-links.mjs", ["--now=2026-08-22"]);
    expect(result.status).toBe("PASS");
    expect(result.offer).toMatchObject({
      status: "STALE_FALLBACK",
      fallbackReason: "OFFICIAL_SOURCE_COVERAGE_INCOMPLETE",
      offerNumbersVisible: false,
      couponCtaVisible: false,
      firstYearRegistrationUsd: null,
      affiliateCouponCode: null,
    });
  });

  it("hides all NameSilo offer values and dated UI labels after 30 days", async () => {
    const result = await runScript("check-commercial-links.mjs", ["--now=2026-09-21"]);
    expect(result.status).toBe("PASS");
    expect(result.offer).toMatchObject({
      status: "STALE_FALLBACK",
      offerNumbersVisible: false,
      couponCtaVisible: false,
      firstYearRegistrationUsd: null,
      affiliateCouponDiscountUsd: null,
      illustrativeEligibleTotalUsd: null,
      affiliateCouponCode: null,
    });
    expect(result.chatgptGuide).toMatchObject({ status: "STALE_GUIDE_FALLBACK", uiPathVisible: false });
    expect(result.cloudflareDocs).toMatchObject({ status: "STALE_DOCS_FALLBACK", permissionLabelsVisible: false });
  });

  it("enforces the full manual, six checkpoints, and zero-secret Safe Manifest", async () => {
    const [docs, prompts, manifest] = await Promise.all([
      runScript("check-setup-docs.mjs"),
      runScript("check-setup-prompts.mjs"),
      runScript("smoke-setup-manifest.mjs", ["--skip-pack"]),
    ]);
    expect(docs).toMatchObject({ status: "PASS", guidedManualSteps: 9, managementCredentialValues: 0 });
    expect(prompts).toMatchObject({
      status: "PASS",
      checkpointCountPerPrompt: 6,
      secretValues: 0,
      filesystemE2eSafety: {
        gated: true,
        hardCodedDrivePaths: 0,
        remoteInstanceConfirmation: "REQUIRED",
        exactAllowedRootsConfirmation: "REQUIRED",
        syntheticFixtureOnly: true,
        fullResultEchoRequested: false,
        secretEchoRequested: false,
        identifierEchoRequested: false,
        deleteHumanConfirmation: "REQUIRED",
      },
    });
    expect(manifest).toMatchObject({
      status: "PASS",
      expectedToolCount: 27,
      secretLikeFields: 0,
      secretLikeValues: 0,
      checkpoints: 6,
    });
  });

  it("keeps direct links attribution-free and accepts the text-only vendor fallback", async () => {
    const [affiliate, vendor] = await Promise.all([
      runScript("check-affiliate-disclosure.mjs"),
      runScript("check-vendor-assets.mjs"),
    ]);
    expect(affiliate).toMatchObject({
      status: "PASS",
      equalVisualWeight: "PASS",
      noReferralRidCount: 0,
      noReferralCouponUse: false,
      clickTelemetry: 0,
    });
    expect(["PASS", "FALLBACK_PASS"]).toContain(vendor.status);
    if (vendor.status === "FALLBACK_PASS") {
      expect(vendor).toMatchObject({ mode: "TEXT_ONLY_FALLBACK", selectedAssetsPublished: 0 });
    }
  });
});
