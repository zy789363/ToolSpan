import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveNpmCli, runDesktopInstall, verificationEnvironment } from "./desktop-install.mjs";
import {
  desktopRoot,
  isFile,
  isSupportedDesktopNodeVersion,
  npmCommand,
  projectRoot,
  requireSuccessfulProcess,
  runCargoOperation,
} from "./desktop-verification-utils.mjs";

export const REQUIRED_DESKTOP_SCRIPTS = ["test", "typecheck", "build", "check:i18n", "test:a11y"];
const PLACEHOLDER = /(?:\.\.\.|\b(?:TODO|TBD|FIXME|placeholder|not implemented)\b)/iu;
const TRIVIAL = /^(?:echo\b|true$|exit\s+0$)/iu;

export function validateDesktopPackageScripts(packageDocument) {
  const errors = [];
  const scripts = packageDocument?.scripts;
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    return ["DESKTOP_SCRIPTS_MISSING"];
  }
  for (const name of REQUIRED_DESKTOP_SCRIPTS) {
    const value = scripts[name];
    if (typeof value !== "string" || value.trim().length === 0) errors.push(`DESKTOP_SCRIPT_MISSING:${name}`);
    else if (PLACEHOLDER.test(value) || TRIVIAL.test(value.trim())) errors.push(`DESKTOP_SCRIPT_NOT_REAL:${name}`);
  }
  if (typeof scripts.tauri !== "string" || scripts.tauri.trim().length === 0
    || PLACEHOLDER.test(scripts.tauri) || TRIVIAL.test(scripts.tauri.trim())) {
    errors.push("DESKTOP_SCRIPT_MISSING:tauri");
  }
  return errors;
}

export function sourceVerificationStepNames() {
  return [
    "DESKTOP_ORCHESTRATOR_TESTS",
    "DESKTOP_CLEAN_INSTALL",
    "DESKTOP_HOST_STANDALONE_BUNDLE",
    "RENDERER_TESTS",
    "RENDERER_TYPECHECK",
    "RENDERER_BUILD",
    "I18N_KEY_PARITY",
    "A11Y_SERIOUS_CRITICAL_ZERO",
    "DESKTOP_PROTOCOL_V1",
    "RUSTFMT",
    "RUST_CHECK",
    "RUST_CLIPPY",
    "RUST_TESTS",
    "DESKTOP_SECURITY_BOUNDARIES",
    "CORE_HEADLESS_VERIFICATION",
    "CORE_PACKED_RELEASE_SMOKE",
  ];
}

async function runDesktopNpmScript(npmCli, script, label) {
  await npmCommand(["--prefix", desktopRoot, "run", script], { npmCli, label });
}

export async function verifyDesktopSource(options = {}) {
  if (!isSupportedDesktopNodeVersion(options.nodeVersion ?? process.versions.node)) {
    return { status: "BLOCKED_BY_ENVIRONMENT", reason: "NODE_VERSION_MUST_MATCH_22_17_OR_24", exitCode: 2 };
  }
  const packagePath = path.join(desktopRoot, "package.json");
  const requiredFiles = [
    packagePath,
    path.join(desktopRoot, "package-lock.json"),
    path.join(projectRoot, "scripts", "bundle-desktop-host.mjs"),
    path.join(desktopRoot, "src-tauri", "Cargo.toml"),
    path.join(desktopRoot, "src-tauri", "Cargo.lock"),
    path.join(projectRoot, "schemas", "desktop-protocol.v1.schema.json"),
  ];
  if (!(await Promise.all(requiredFiles.map(isFile))).every(Boolean)) {
    return { status: "FAIL", classification: "REGRESSION", reason: "DESKTOP_SOURCE_INPUT_MISSING", exitCode: 1 };
  }

  const desktopPackage = JSON.parse(await readFile(packagePath, "utf8"));
  const scriptErrors = validateDesktopPackageScripts(desktopPackage);
  if (scriptErrors.length > 0) {
    return {
      status: "FAIL",
      classification: "REGRESSION",
      reason: "DESKTOP_PACKAGE_SCRIPTS_INVALID",
      details: scriptErrors,
      exitCode: 1,
    };
  }

  const environment = verificationEnvironment(options.environment ?? process.env);
  const npmCli = options.npmCli ?? await resolveNpmCli(environment);
  if (npmCli === null) {
    return { status: "BLOCKED_BY_ENVIRONMENT", reason: "NPM_CLI_NOT_FOUND", exitCode: 2 };
  }

  const install = await (options.install ?? runDesktopInstall)({
    projectRoot,
    environment,
    npmCli,
  });
  if (install.status !== "PASS") return install;

  try {
    await npmCommand(["run", "build"], { npmCli, label: "Desktop host standalone bundle" });
    await requireSuccessfulProcess(
      "Desktop verification script unit tests",
      process.execPath,
      ["--test", "scripts/tests/desktop-verification.test.mjs"],
      { environment },
    );
    await runDesktopNpmScript(npmCli, "test", "renderer unit/component and mocked Tauri tests");
    await runDesktopNpmScript(npmCli, "typecheck", "renderer typecheck");
    await runDesktopNpmScript(npmCli, "build", "renderer production build");
    await runDesktopNpmScript(npmCli, "check:i18n", "English and zh-CN key parity");
    await runDesktopNpmScript(npmCli, "test:a11y", "axe serious/critical accessibility gate");
    await npmCommand(["run", "desktop:protocol:check"], { npmCli, label: "Desktop protocol v1 integration" });
    await runCargoOperation("fmt", { environment, label: "Rust formatting" });
    await runCargoOperation("check", { environment, label: "Rust source check" });
    await runCargoOperation("clippy", { environment, label: "Rust clippy warnings gate" });
    await runCargoOperation("test", { environment, label: "Rust unit tests" });
    await npmCommand(["run", "check:desktop:security"], { npmCli, label: "Desktop security boundaries" });
    await npmCommand(["run", "verify:core"], { npmCli, label: "Core headless regression" });
    await npmCommand(["run", "smoke:core-release"], { npmCli, label: "Core packed release smoke" });
    return { status: "PASS", checks: sourceVerificationStepNames(), exitCode: 0 };
  } catch (error) {
    if (["MSVC_BUILD_TOOLS_NOT_DETECTED", "NPM_CLI_NOT_FOUND", "ENOENT"].includes(error?.code)) {
      return { status: "BLOCKED_BY_ENVIRONMENT", reason: error.code, exitCode: 2 };
    }
    return {
      status: "FAIL",
      classification: "REGRESSION",
      reason: "DESKTOP_SOURCE_VERIFICATION_FAILED",
      failedStep: error instanceof Error ? error.message : "unknown step",
      exitCode: 1,
    };
  }
}

async function main() {
  try {
    const result = await verifyDesktopSource();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode;
  } catch {
    process.stdout.write(`${JSON.stringify({
      status: "FAIL",
      classification: "REGRESSION",
      reason: "DESKTOP_SOURCE_VERIFICATION_CRASHED",
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
