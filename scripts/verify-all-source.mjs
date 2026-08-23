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
    "GOAL_CHECK",
    "CORE_SOURCE",
    "DESKTOP_SOURCE",
    "SETUP_SOURCE",
  ];
}

async function runRootScript(npmCli, script, label, environment) {
  await npmCommand(["run", script], { npmCli, label, environment });
}

export async function verifyAllSource(options = {}) {
  if (!isSupportedDesktopNodeVersion(options.nodeVersion ?? process.versions.node)) {
    return { status: "BLOCKED_BY_ENVIRONMENT", reason: "NODE_VERSION_MUST_MATCH_22_17_OR_24", exitCode: 2 };
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
      exitCode: 1,
    };
  }

  const environment = verificationEnvironment(options.environment ?? process.env);
  const npmCli = options.npmCli ?? await resolveNpmCli(environment);
  if (npmCli === null) return { status: "BLOCKED_BY_ENVIRONMENT", reason: "NPM_CLI_NOT_FOUND", exitCode: 2 };
  const runRoot = options.runRoot ?? ((script, label) => runRootScript(npmCli, script, label, environment));
  const runUnitTests = options.runUnitTests ?? (() => requireSuccessfulProcess(
    "Release orchestration script unit tests",
    process.execPath,
    [
      "--test",
      "scripts/tests/release-scripts.test.mjs",
      "scripts/tests/package-runtime-policy.test.mjs",
      "scripts/tests/cloudflared-service-lifecycle.test.mjs",
    ],
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
        exitCode: 2,
      };
    }
    return {
      status: "FAIL",
      classification: "REGRESSION",
      reason: "SOURCE_VERIFICATION_FAILED",
      failedStep: error instanceof Error ? error.message : "unknown step",
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
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
