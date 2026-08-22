import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { resolveNpmCli, runDesktopInstall, verificationEnvironment } from "./desktop-install.mjs";
import {
  desktopRoot,
  detectWebView2,
  findBundleArtifacts,
  findVisualStudio,
  isFile,
  isSupportedDesktopNodeVersion,
  projectRoot,
  resolveCscript,
  resolveWindowsPowerShell,
  runProcess,
  runVisualStudioOperation,
} from "./desktop-verification-utils.mjs";

const ROOT_BUILD_INVOCATION = "& $NodePath $NpmCliPath --prefix $ProjectRoot run build";
const RENDERER_BUILD_INVOCATION = "& $NodePath $NpmCliPath --prefix $DesktopRoot run build";
const TAURI_BUILD_INVOCATION = "& $NodePath $NpmCliPath --prefix $DesktopRoot run tauri -- build";
const REQUIRED_RENDERER_BUILD_SCRIPT = "tsc -p tsconfig.json --noEmit && vite build";

export function validateWindowsTauriBuildPipeline({ desktopPackage, visualStudioHelper }) {
  const errors = [];
  if (desktopPackage === null || typeof desktopPackage !== "object" || Array.isArray(desktopPackage)) {
    errors.push("DESKTOP_PACKAGE_INVALID");
  } else if (desktopPackage.scripts?.build?.trim() !== REQUIRED_RENDERER_BUILD_SCRIPT) {
    errors.push("DESKTOP_RENDERER_BUILD_SCRIPT_INVALID");
  }
  if (typeof visualStudioHelper !== "string") {
    errors.push("WINDOWS_BUILD_HELPER_INVALID");
    return errors;
  }

  const rootBuild = visualStudioHelper.indexOf(ROOT_BUILD_INVOCATION);
  const rendererBuild = visualStudioHelper.indexOf(RENDERER_BUILD_INVOCATION);
  const tauriBuild = visualStudioHelper.indexOf(TAURI_BUILD_INVOCATION);
  if (rendererBuild < 0) errors.push("DESKTOP_RENDERER_BUILD_NOT_IN_TAURI_PIPELINE");
  if (rootBuild < 0 || tauriBuild < 0 || rootBuild >= tauriBuild) {
    errors.push("WINDOWS_TAURI_BUILD_SEQUENCE_INVALID");
  } else if (rendererBuild >= 0 && (rendererBuild <= rootBuild || rendererBuild >= tauriBuild)) {
    errors.push("DESKTOP_RENDERER_BUILD_NOT_BEFORE_TAURI");
  }
  if (rendererBuild >= 0 && tauriBuild > rendererBuild) {
    const rendererFailureBoundary = visualStudioHelper.slice(
      rendererBuild + RENDERER_BUILD_INVOCATION.length,
      tauriBuild,
    );
    if (!/if\s*\(\$LASTEXITCODE -ne 0\)\s*\{\s*exit \$LASTEXITCODE\s*\}/u.test(rendererFailureBoundary)) {
      errors.push("DESKTOP_RENDERER_BUILD_FAILURE_NOT_PROPAGATED");
    }
  }
  return errors;
}

export function classifyWindowsPrerequisites(capabilities) {
  const reasons = [];
  if (capabilities.platform !== "win32" || capabilities.architecture !== "x64") {
    reasons.push("WINDOWS_X64_REQUIRED");
  }
  if (!capabilities.desktopInputs) reasons.push("DESKTOP_SOURCE_INPUT_MISSING");
  if (!capabilities.npmCli) reasons.push("NPM_CLI_NOT_FOUND");
  if (!capabilities.visualStudio) reasons.push("MSVC_BUILD_TOOLS_NOT_DETECTED");
  if (!capabilities.powershell) reasons.push("WINDOWS_POWERSHELL_NOT_FOUND");
  if (!capabilities.cscript) reasons.push("CSCRIPT_NOT_FOUND");
  if (!capabilities.vbscript) reasons.push("VBSCRIPT_ENGINE_UNAVAILABLE");
  if (!capabilities.webView2) reasons.push("WEBVIEW2_NOT_DETECTED");
  return reasons;
}

export async function collectWindowsPrerequisites(options = {}) {
  const environment = verificationEnvironment(options.environment ?? process.env);
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const requiredFiles = [
    path.join(desktopRoot, "package.json"),
    path.join(desktopRoot, "package-lock.json"),
    path.join(desktopRoot, "src-tauri", "Cargo.toml"),
    path.join(desktopRoot, "src-tauri", "Cargo.lock"),
    path.join(desktopRoot, "src-tauri", "tauri.conf.json"),
    path.join(projectRoot, "scripts", "invoke-desktop-vs.ps1"),
    path.join(projectRoot, "scripts", "probe-vbscript.vbs"),
  ];
  const desktopInputs = (await Promise.all(requiredFiles.map(isFile))).every(Boolean);
  if (platform !== "win32" || architecture !== "x64") {
    return {
      platform,
      architecture,
      nodeVersion,
      desktopInputs,
      npmCli: null,
      visualStudio: null,
      powershell: null,
      cscript: null,
      vbscript: false,
      webView2: false,
    };
  }

  const [npmCli, visualStudio, powershell, cscript, webView2] = await Promise.all([
    resolveNpmCli(environment),
    findVisualStudio({ environment }),
    resolveWindowsPowerShell(environment),
    resolveCscript(environment),
    detectWebView2({ environment }),
  ]);
  let vbscript = false;
  if (cscript !== null) {
    const result = await (options.runner ?? runProcess)(cscript, [
      "//Nologo",
      path.join(projectRoot, "scripts", "probe-vbscript.vbs"),
    ], { capture: true, timeoutMilliseconds: 10_000, environment });
    vbscript = result.started && result.code === 0;
  }
  return {
    platform,
    architecture,
    nodeVersion,
    desktopInputs,
    npmCli,
    visualStudio,
    powershell,
    cscript,
    vbscript,
    webView2,
  };
}

export async function verifyDesktopWindows(options = {}) {
  const capabilities = options.capabilities ?? await collectWindowsPrerequisites(options);
  if (!isSupportedDesktopNodeVersion(capabilities.nodeVersion ?? options.nodeVersion ?? process.versions.node)) {
    return {
      status: "BLOCKED_BY_ENVIRONMENT",
      gate: "WINDOWS_NATIVE_VALIDATION",
      reasons: ["NODE_VERSION_MUST_MATCH_22_17_OR_24"],
      exitCode: 2,
    };
  }
  const blockedReasons = classifyWindowsPrerequisites(capabilities);
  if (blockedReasons.length > 0) {
    return {
      status: "BLOCKED_BY_ENVIRONMENT",
      gate: "WINDOWS_NATIVE_VALIDATION",
      reasons: blockedReasons,
      exitCode: 2,
    };
  }

  let desktopPackage;
  let visualStudioHelper;
  try {
    [desktopPackage, visualStudioHelper] = await Promise.all([
      readFile(path.join(desktopRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(path.join(projectRoot, "scripts", "invoke-desktop-vs.ps1"), "utf8"),
    ]);
  } catch {
    return {
      status: "FAIL",
      classification: "REGRESSION",
      reason: "WINDOWS_TAURI_BUILD_PIPELINE_INVALID",
      details: ["WINDOWS_TAURI_BUILD_INPUT_INVALID"],
      exitCode: 1,
    };
  }
  const pipelineErrors = validateWindowsTauriBuildPipeline({ desktopPackage, visualStudioHelper });
  if (pipelineErrors.length > 0) {
    return {
      status: "FAIL",
      classification: "REGRESSION",
      reason: "WINDOWS_TAURI_BUILD_PIPELINE_INVALID",
      details: pipelineErrors,
      exitCode: 1,
    };
  }

  const environment = verificationEnvironment(options.environment ?? process.env);
  const install = await (options.install ?? runDesktopInstall)({
    projectRoot,
    environment,
    npmCli: capabilities.npmCli,
  });
  if (install.status !== "PASS") return install;

  try {
    const packageVersion = options.packageVersion ?? desktopPackage.version;
    if (typeof packageVersion !== "string") {
      return {
        status: "FAIL",
        classification: "REGRESSION",
        reason: "DESKTOP_PACKAGE_VERSION_INVALID",
        exitCode: 1,
      };
    }
    const runVsOperation = options.runVsOperation ?? runVisualStudioOperation;
    await runVsOperation("probe", {
      environment,
      visualStudio: capabilities.visualStudio,
      powershell: capabilities.powershell,
      label: "Visual C++ developer shell probe",
    });
    await runVsOperation("tauri-build", {
      environment,
      npmCli: capabilities.npmCli,
      visualStudio: capabilities.visualStudio,
      powershell: capabilities.powershell,
      label: "Tauri release native build and bundle",
    });
    const artifacts = await (options.findArtifacts ?? findBundleArtifacts)({
      root: options.bundleRoot,
      version: packageVersion,
    });
    if (artifacts.length !== 2) {
      return {
        status: "FAIL",
        classification: "REGRESSION",
        reason: "TAURI_CURRENT_VERSION_BUNDLE_INCOMPLETE",
        exitCode: 1,
      };
    }
    return {
      status: "EXTERNAL_GATE_PENDING",
      gate: "WINDOWS_NATIVE_VALIDATION",
      validatedSubgate: "WINDOWS_RELEASE_NATIVE_BUILD",
      checks: [
        "VSWHERE_VC_TOOLCHAIN",
        "LAUNCH_VS_DEV_SHELL",
        "CSCRIPT_VBSCRIPT_ENGINE",
        "WEBVIEW2_RUNTIME",
        "DESKTOP_RENDERER_TYPECHECK",
        "DESKTOP_RENDERER_BUILD",
        "TAURI_RELEASE_BUILD",
        "CURRENT_VERSION_X64_MSI",
        "CURRENT_VERSION_X64_NSIS",
      ],
      bundleArtifactCount: artifacts.length,
      bundleArtifacts: artifacts,
      manualEvidencePending: ["INSTALL_SMOKE", "TRAY_SMOKE", "OWNED_PROCESS_SMOKE"],
      exitCode: 0,
    };
  } catch (error) {
    if (["MSVC_BUILD_TOOLS_NOT_DETECTED", "NPM_CLI_NOT_FOUND", "ENOENT"].includes(error?.code)) {
      return {
        status: "BLOCKED_BY_ENVIRONMENT",
        gate: "WINDOWS_NATIVE_VALIDATION",
        reasons: [error.code],
        exitCode: 2,
      };
    }
    return {
      status: "FAIL",
      classification: "REGRESSION",
      reason: "WINDOWS_NATIVE_BUILD_FAILED",
      exitCode: 1,
    };
  }
}

async function main() {
  try {
    const result = await verifyDesktopWindows();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode;
  } catch {
    process.stdout.write(`${JSON.stringify({
      status: "FAIL",
      classification: "REGRESSION",
      reason: "WINDOWS_NATIVE_VERIFICATION_CRASHED",
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
