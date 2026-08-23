import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveNpmCli, verificationEnvironment } from "./desktop-install.mjs";
import {
  desktopRoot,
  isFile,
  isSupportedDesktopNodeVersion,
  npmCommand,
  projectRoot,
  requireSuccessfulProcess,
  runCargoOperation,
} from "./desktop-verification-utils.mjs";

export const REQUIRED_SETUP_SCRIPTS = [
  "build",
  "desktop:install",
  "setup:test",
  "check:setup-docs",
  "check:setup-prompts",
  "check:commercial-links",
  "check:affiliate-disclosure",
  "check:vendor-assets",
  "smoke:setup-manifest",
  "check:setup:security",
  "verify:core",
  "verify:desktop:source",
];

export const SETUP_GOAL_IDS = [
  "S-LOCK-01",
  "S-STATE-01",
  "S-CRED-01",
  "S-TUNNEL-CRED-01",
  "S-CF-MANUAL-01",
  "S-CF-ZONE-01",
  "S-CF-TOKEN-01",
  "S-CF-IDEMP-01",
  "S-CF-ROLLBACK-01",
  "S-CGPT-01",
  "S-AGENT-01",
  "S-DOMAIN-01",
  "S-AFF-01",
  "S-AFF-02",
  "S-ASSET-01",
  "S-URL-01",
  "S-DIAG-01",
  "S-MOCK-01",
  "S-EXTENV-01",
  "S-PACK-01",
];

export const MINIMUM_SETUP_SCENARIO_DECLARATIONS = 23;

const PLACEHOLDER = /(?:\.\.\.|\b(?:TODO|TBD|FIXME|placeholder|not implemented)\b)/iu;
const TRIVIAL = /^(?:echo\b|true$|exit\s+0$)/iu;
const RECURSIVE_SETUP_CALL = /\bnpm(?:\s+--prefix\s+\S+)?\s+run\s+(?:verify:setup|verify:all:source)\b/iu;
const SHELL_GLOB = /[*?{}[\]]/u;

export function validateSetupPackageScripts(packageDocument) {
  const scripts = packageDocument?.scripts;
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    return ["SETUP_SCRIPTS_MISSING"];
  }
  const errors = [];
  for (const name of [...REQUIRED_SETUP_SCRIPTS, "verify:setup"]) {
    const value = scripts[name];
    if (typeof value !== "string" || value.trim().length === 0) errors.push(`SETUP_SCRIPT_MISSING:${name}`);
    else if (PLACEHOLDER.test(value) || TRIVIAL.test(value.trim())) errors.push(`SETUP_SCRIPT_NOT_REAL:${name}`);
  }
  for (const name of REQUIRED_SETUP_SCRIPTS) {
    const value = scripts[name];
    if (typeof value === "string" && RECURSIVE_SETUP_CALL.test(value)) {
      errors.push(`SETUP_SCRIPT_RECURSION:${name}`);
    }
    if (typeof value === "string" && SHELL_GLOB.test(value)) {
      errors.push(`SETUP_SCRIPT_SHELL_GLOB:${name}`);
    }
  }
  return errors;
}

export function countSetupScenarioDeclarations(source) {
  return [...String(source).matchAll(/\b(?:it|test)(?:\.each)?\s*\(/gu)].length;
}

export function setupVerificationStepNames() {
  return [
    "SETUP_ORCHESTRATOR_TESTS",
    "DESKTOP_CLEAN_INSTALL",
    "SETUP_ENGINE_AND_CLOUDFLARE_MOCKS",
    "SETUP_GUIDED_DOCS",
    "SETUP_PROMPT_PACK",
    "COMMERCIAL_LINKS_AND_STALE_FALLBACK",
    "AFFILIATE_DISCLOSURE_AND_DIRECT_PATH",
    "VENDOR_ASSET_OR_TEXT_ONLY_FALLBACK",
    "SAFE_MANIFEST_AND_PACKAGED_SETUP_SMOKE",
    "SETUP_SECURITY_AND_NO_SECRET_SCAN",
    "SETUP_UI_FOCUSED_TESTS",
    "SETUP_UI_TYPECHECK",
    "SETUP_UI_BUILD",
    "SETUP_UI_I18N",
    "SETUP_UI_A11Y",
    "CORE_DESKTOP_HOST_BUILD",
    "RUSTFMT",
    "RUST_CHECK",
    "RUST_CLIPPY",
    "RUST_TESTS",
    "CORE_SOURCE_REGRESSION",
    "DESKTOP_SOURCE_REGRESSION",
  ];
}

export function setupExternalGateSummary() {
  return {
    cloudflareSandbox: "EXTERNAL_GATE_PENDING",
    hostValidation: "EXTERNAL_GATE_PENDING",
    note: "Deterministic Setup verification never promotes an unexecuted external gate to PASS",
  };
}

async function runRootScript(npmCli, script, label, environment) {
  await npmCommand(["run", script], { npmCli, label, environment });
}

async function runDesktopScript(npmCli, script, label, environment, trailingArguments = []) {
  await npmCommand(
    ["--prefix", desktopRoot, "run", script, ...(trailingArguments.length > 0 ? ["--", ...trailingArguments] : [])],
    { npmCli, label, environment },
  );
}

function requiredSetupInputs() {
  return [
    path.join(projectRoot, "package.json"),
    path.join(projectRoot, "package-lock.json"),
    path.join(projectRoot, "goal", "requirements.json"),
    path.join(projectRoot, "scripts", "check-setup-security.mjs"),
    path.join(projectRoot, "scripts", "check-setup-docs.mjs"),
    path.join(projectRoot, "scripts", "check-setup-prompts.mjs"),
    path.join(projectRoot, "scripts", "check-commercial-links.mjs"),
    path.join(projectRoot, "scripts", "check-affiliate-disclosure.mjs"),
    path.join(projectRoot, "scripts", "check-vendor-assets.mjs"),
    path.join(projectRoot, "scripts", "smoke-setup-manifest.mjs"),
    path.join(projectRoot, "tests", "setup-engine.test.ts"),
    path.join(desktopRoot, "package.json"),
    path.join(desktopRoot, "package-lock.json"),
    path.join(desktopRoot, "tests", "components", "setup-page.test.tsx"),
    path.join(desktopRoot, "src-tauri", "Cargo.toml"),
    path.join(desktopRoot, "src-tauri", "Cargo.lock"),
  ];
}

export async function verifySetup(options = {}) {
  if (!isSupportedDesktopNodeVersion(options.nodeVersion ?? process.versions.node)) {
    return { status: "BLOCKED_BY_ENVIRONMENT", reason: "NODE_VERSION_MUST_MATCH_22_17_OR_24", exitCode: 2 };
  }

  const inputs = options.requiredInputs ?? requiredSetupInputs();
  if (!(await Promise.all(inputs.map((filePath) => (options.isFile ?? isFile)(filePath)))).every(Boolean)) {
    return {
      status: "FAIL",
      classification: "REGRESSION",
      reason: "SETUP_SOURCE_INPUT_MISSING",
      exitCode: 1,
    };
  }

  const packageDocument = options.packageDocument
    ?? JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const scriptErrors = validateSetupPackageScripts(packageDocument);
  if (scriptErrors.length > 0) {
    return {
      status: "FAIL",
      classification: "REGRESSION",
      reason: "SETUP_PACKAGE_SCRIPTS_INVALID",
      details: scriptErrors,
      exitCode: 1,
    };
  }

  const scenarioSource = options.setupScenarioSource
    ?? await readFile(path.join(projectRoot, "tests", "setup-engine.test.ts"), "utf8");
  const scenarioDeclarations = countSetupScenarioDeclarations(scenarioSource);
  if (scenarioDeclarations < MINIMUM_SETUP_SCENARIO_DECLARATIONS) {
    return {
      status: "FAIL",
      classification: "REGRESSION",
      reason: "SETUP_MOCK_SCENARIO_COVERAGE_INSUFFICIENT",
      scenarioDeclarations,
      minimumScenarioDeclarations: MINIMUM_SETUP_SCENARIO_DECLARATIONS,
      exitCode: 1,
    };
  }

  const environment = verificationEnvironment(options.environment ?? process.env);
  const npmCli = options.npmCli ?? await resolveNpmCli(environment);
  if (npmCli === null) {
    return { status: "BLOCKED_BY_ENVIRONMENT", reason: "NPM_CLI_NOT_FOUND", exitCode: 2 };
  }

  const runRoot = options.runRoot ?? ((script, label) => runRootScript(npmCli, script, label, environment));
  const runDesktop = options.runDesktop
    ?? ((script, label, trailingArguments = []) => runDesktopScript(
      npmCli,
      script,
      label,
      environment,
      trailingArguments,
    ));
  const runCargo = options.runCargo
    ?? ((operation, label) => runCargoOperation(operation, { environment, label }));
  const runOrchestratorTests = options.runOrchestratorTests
    ?? (() => requireSuccessfulProcess(
      "Setup verification script unit tests",
      process.execPath,
      ["--test", "scripts/tests/setup-verification.test.mjs"],
      { environment },
    ));

  try {
    await runOrchestratorTests();
    await runRoot("desktop:install", "Desktop clean install for Setup UI verification");
    await runRoot("setup:test", "Setup engine and Cloudflare mock scenarios");
    await runRoot("check:setup-docs", "guided manual and ChatGPT Setup documentation");
    await runRoot("check:setup-prompts", "safe Prompt Pack and six human checkpoints");
    await runRoot("check:commercial-links", "commercial links and stale-data fallback");
    await runRoot("check:affiliate-disclosure", "affiliate disclosure and no-referral parity");
    await runRoot("check:vendor-assets", "verified vendor assets or text-only FALLBACK_PASS");
    await runRoot("smoke:setup-manifest", "safe manifest and packaged Setup smoke");
    await runRoot("check:setup:security", "Setup security boundaries and no-secret scan");
    await runDesktop("test", "Setup UI focused tests", ["tests/components/setup-page.test.tsx"]);
    await runDesktop("typecheck", "Setup UI typecheck", []);
    await runDesktop("build", "Setup UI production build", []);
    await runDesktop("check:i18n", "Setup UI English and zh-CN key parity", []);
    await runDesktop("test:a11y", "Setup UI axe serious/critical accessibility gate", []);
    await runRoot("build", "Core and Desktop Host build for the embedded Tauri resource");
    await runCargo("fmt", "Setup Rust formatting");
    await runCargo("check", "Setup Rust source check");
    await runCargo("clippy", "Setup Rust clippy warnings gate");
    await runCargo("test", "Setup Rust unit tests");
    await runRoot("verify:core", "Core source regression");
    await runRoot("verify:desktop:source", "Desktop source regression");
    return {
      status: "PASS",
      stageStatus: "SETUP_IMPLEMENTATION_COMPLETE",
      deterministicOnly: true,
      checks: setupVerificationStepNames(),
      setupScenarioDeclarations: scenarioDeclarations,
      externalGates: setupExternalGateSummary(),
      exitCode: 0,
    };
  } catch (error) {
    if (["MSVC_BUILD_TOOLS_NOT_DETECTED", "NPM_CLI_NOT_FOUND", "ENOENT"].includes(error?.code)) {
      return { status: "BLOCKED_BY_ENVIRONMENT", reason: error.code, exitCode: 2 };
    }
    return {
      status: "FAIL",
      classification: "REGRESSION",
      reason: "SETUP_SOURCE_VERIFICATION_FAILED",
      failedStep: error instanceof Error ? error.message : "unknown step",
      externalGates: setupExternalGateSummary(),
      exitCode: 1,
    };
  }
}

async function main() {
  try {
    const result = await verifySetup();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode;
  } catch {
    process.stdout.write(`${JSON.stringify({
      status: "FAIL",
      classification: "REGRESSION",
      reason: "SETUP_SOURCE_VERIFICATION_CRASHED",
      externalGates: setupExternalGateSummary(),
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
