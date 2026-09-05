import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveNpmCli, verificationEnvironment } from "./desktop-install.mjs";
import { isSupportedDesktopNodeVersion, npmCommand, requireSuccessfulProcess } from "./desktop-verification-utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(scriptDirectory, "..");
export const REQUIRED_SOURCE_SCRIPTS = [
  "goal:check",
  "verify:core",
  "verify:desktop:source",
  "verify:setup",
];

// 这些测试只调用本地实现、固定 fixture 或 mock；不得把需要凭据、远程账户
// 或人工授权的 e2e:* 命令加入这里。
export const DETERMINISTIC_SOURCE_TEST_FILES = Object.freeze([
  "scripts/tests/cloudflare-e2e.test.mjs",
  "scripts/tests/cloudflare-public-e2e.test.mjs",
  "scripts/tests/cloudflared-service-lifecycle.test.mjs",
  "scripts/tests/codex-remote-e2e.test.mjs",
  "scripts/tests/desktop-verification.test.mjs",
  "scripts/tests/goal-scripts.test.mjs",
  "scripts/tests/host-e2e-safety.test.mjs",
  "scripts/tests/package-runtime-policy.test.mjs",
  "scripts/tests/release-scripts.test.mjs",
  "scripts/tests/setup-verification.test.mjs",
  "scripts/tests/source-verification.test.mjs",
]);

export const EXTERNAL_E2E_GATES = Object.freeze([
  Object.freeze({
    id: "E-CF-TOKEN-01",
    script: "e2e:cloudflare",
    status: "EXTERNAL_GATE_PENDING",
    reason: "requires an external Cloudflare account and credential",
  }),
  Object.freeze({
    id: "E-CF-WIN-01",
    script: "e2e:cloudflare-public",
    status: "EXTERNAL_GATE_PENDING",
    reason: "requires an external Cloudflare account and Windows service environment",
  }),
  Object.freeze({
    id: "E-HOST-01",
    script: "e2e:mcp-inspector",
    status: "EXTERNAL_GATE_PENDING",
    reason: "requires an external Host authorization and human checkpoint",
  }),
  Object.freeze({
    id: "E-CODEX-01",
    script: "e2e:codex-remote",
    status: "EXTERNAL_GATE_PENDING",
    reason: "requires an external Codex account and remote endpoint",
  }),
]);

const PLACEHOLDER = /(?:\.\.\.|\b(?:TODO|TBD|FIXME|placeholder|not implemented)\b)/iu;
const SHELL_META = /(?:&&|\|\||[<>]|\$\(|`)/u;

export function validateAllSourcePackageScripts(packageDocument) {
  const errors = [];
  const scripts = packageDocument?.scripts;
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    return ["SOURCE_PACKAGE_SCRIPTS_MISSING"];
  }
  for (const name of REQUIRED_SOURCE_SCRIPTS) {
    const command = scripts[name];
    if (typeof command !== "string" || command.trim().length === 0 || PLACEHOLDER.test(command)) {
      errors.push(`SOURCE_SCRIPT_NOT_REAL:${name}`);
      continue;
    }
    if (SHELL_META.test(command)) errors.push(`SOURCE_SCRIPT_SHELL_META:${name}`);
    if (/\bnpm(?:\.cmd)?\s+run\s+verify:all:source\b/iu.test(command)
      || /\bnode(?:\.exe)?\s+scripts[\\/]verify-all-source\.mjs\b/iu.test(command)) {
      errors.push(`SOURCE_SCRIPT_RECURSION:${name}`);
    }
  }
  return errors;
}

export function allSourceStepNames() {
  return [
    "DETERMINISTIC_SOURCE_SCRIPT_TESTS",
    "GOAL_CHECK",
    "CORE_SOURCE",
    "DESKTOP_SOURCE",
    "SETUP_SOURCE",
  ];
}

export function deterministicSourceTestArguments() {
  return ["--test", ...DETERMINISTIC_SOURCE_TEST_FILES];
}

export function externalSourceGateSummary() {
  return EXTERNAL_E2E_GATES.map((gate) => ({ ...gate }));
}

async function runRootScript(npmCli, script, label, environment) {
  await npmCommand(["run", script], { npmCli, label, environment });
}

export async function verifyAllSource(options = {}) {
  if (!isSupportedDesktopNodeVersion(options.nodeVersion ?? process.versions.node)) {
    return {
      status: "BLOCKED_BY_ENVIRONMENT",
      reason: "NODE_VERSION_MUST_MATCH_22_17_OR_24",
      externalGates: externalSourceGateSummary(),
      exitCode: 2,
    };
  }
  const packageDocument = options.packageDocument
    ?? JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const scriptErrors = validateAllSourcePackageScripts(packageDocument);
  if (scriptErrors.length > 0) {
    return {
      status: "FAIL",
      classification: "REGRESSION",
      reason: "SOURCE_PACKAGE_SCRIPTS_INVALID",
      details: scriptErrors,
      externalGates: externalSourceGateSummary(),
      exitCode: 1,
    };
  }

  const environment = verificationEnvironment(options.environment ?? process.env);
  const npmCli = options.npmCli ?? await resolveNpmCli(environment);
  if (npmCli === null) {
    return {
      status: "BLOCKED_BY_ENVIRONMENT",
      reason: "NPM_CLI_NOT_FOUND",
      externalGates: externalSourceGateSummary(),
      exitCode: 2,
    };
  }
  const runRoot = options.runRoot ?? ((script, label) => runRootScript(npmCli, script, label, environment));
  const runUnitTests = options.runUnitTests ?? (() => requireSuccessfulProcess(
    "Deterministic source helper script tests",
    process.execPath,
    deterministicSourceTestArguments(),
    { environment },
  ));

  try {
    await runUnitTests();
    await runRoot("goal:check", "Goal requirements and state validation");
    await runRoot("verify:core", "Core source verification");
    await runRoot("verify:desktop:source", "Desktop source verification");
    await runRoot("verify:setup", "Setup source verification");
    return {
      status: "PASS",
      stageStatuses: [
        "CORE_IMPLEMENTATION_COMPLETE",
        "DESKTOP_SOURCE_COMPLETE",
        "SETUP_IMPLEMENTATION_COMPLETE",
      ],
      checks: allSourceStepNames(),
      deterministicSourceTests: [...DETERMINISTIC_SOURCE_TEST_FILES],
      externalGates: externalSourceGateSummary(),
      shell: false,
      externalGatesPromotedToPass: 0,
      exitCode: 0,
    };
  } catch (error) {
    if (error?.exitCode === 2 || ["NPM_CLI_NOT_FOUND", "MSVC_BUILD_TOOLS_NOT_DETECTED", "ENOENT"].includes(error?.code)) {
      return {
        status: "BLOCKED_BY_ENVIRONMENT",
        reason: error?.exitCode === 2 ? "SOURCE_VERIFICATION_ENVIRONMENT_BLOCKED" : error.code,
        failedStep: error instanceof Error ? error.message : "unknown step",
        externalGates: externalSourceGateSummary(),
        exitCode: 2,
      };
    }
    return {
      status: "FAIL",
      classification: "REGRESSION",
      reason: "SOURCE_VERIFICATION_FAILED",
      failedStep: error instanceof Error ? error.message : "unknown step",
      externalGates: externalSourceGateSummary(),
      exitCode: 1,
    };
  }
}

async function main() {
  try {
    const result = await verifyAllSource();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode;
  } catch {
    process.stdout.write(`${JSON.stringify({
      status: "FAIL",
      classification: "REGRESSION",
      reason: "SOURCE_VERIFICATION_CRASHED",
      externalGates: externalSourceGateSummary(),
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
