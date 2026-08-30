import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { findVisualStudio } from "./desktop-verification-utils.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const SECRET_ENVIRONMENT_VARIABLE_NAMES = ["TOOLSPAN_E2E_CF_API_TOKEN"];

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function run(command, arguments_ = [], options = {}) {
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 8_000;
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? projectRoot,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ available: true, ok: false, timedOut: true, stdout: "", stderr: "" });
    }, timeoutMilliseconds);
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 16_384) stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 16_384) stderr += String(chunk);
    });
    child.once("error", (error) => finish({
      available: error.code !== "ENOENT",
      ok: false,
      timedOut: false,
      stdout: "",
      stderr: "",
    }));
    child.once("close", (code) => finish({
      available: true,
      ok: code === 0,
      timedOut: false,
      stdout,
      stderr,
    }));
  });
}

async function resolveNpmInvocation() {
  const fromNpm = process.env.npm_execpath;
  if (typeof fromNpm === "string" && fromNpm.length > 0 && await exists(fromNpm)) {
    return { command: process.execPath, prefix: [fromNpm] };
  }
  if (!isWindows) return { command: "npm", prefix: [] };
  const located = await run("where.exe", ["npm.cmd"]);
  if (located.ok) {
    const wrapper = located.stdout.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim();
    if (wrapper !== undefined) {
      const cli = path.join(path.dirname(wrapper), "node_modules", "npm", "bin", "npm-cli.js");
      if (await exists(cli)) return { command: process.execPath, prefix: [cli] };
    }
  }
  return null;
}

function versionOnly(result, expression = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/u) {
  if (!result.available || !result.ok) return null;
  return expression.exec(`${result.stdout}\n${result.stderr}`)?.[1] ?? null;
}

export function parseNodeVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(String(value).trim());
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNodeAtLeast(value, minimum = [22, 17, 0]) {
  const parsed = parseNodeVersion(value);
  if (parsed === null) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (parsed[index] > minimum[index]) return true;
    if (parsed[index] < minimum[index]) return false;
  }
  return true;
}

async function fetchReachability(url) {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(7_000),
      headers: { "user-agent": "ToolSpan-goal-preflight" },
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function canBindLoopback() {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function registryNameSources(variableName) {
  const sources = [];
  if (Object.keys(process.env).some((name) => name.toLowerCase() === variableName.toLowerCase())) {
    sources.push("processEnvironmentName");
  }
  if (!isWindows) return sources;
  const script = String.raw`
$target = '${variableName}'
$found = New-Object System.Collections.Generic.List[string]
try {
  $user = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::CurrentUser,
    [Microsoft.Win32.RegistryView]::Default
  ).OpenSubKey('Environment')
  if ($null -ne $user -and $user.GetValueNames() -contains $target) { $found.Add('userRegistryName') }
  if ($null -ne $user) { $user.Dispose() }
} catch {}
try {
  $machine = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::LocalMachine,
    [Microsoft.Win32.RegistryView]::Default
  ).OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment')
  if ($null -ne $machine -and $machine.GetValueNames() -contains $target) { $found.Add('machineRegistryName') }
  if ($null -ne $machine) { $machine.Dispose() }
} catch {}
[Console]::Out.Write(($found | ConvertTo-Json -Compress))
`;
  const result = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
  if (!result.ok || result.stdout.trim().length === 0) return sources;
  try {
    const parsed = JSON.parse(result.stdout);
    for (const source of Array.isArray(parsed) ? parsed : [parsed]) {
      if (["userRegistryName", "machineRegistryName"].includes(source) && !sources.includes(source)) {
        sources.push(source);
      }
    }
  } catch {
    // A registry check failure is reported as absence; raw output is intentionally never exposed.
  }
  return sources;
}

async function readGoalStage() {
  try {
    const state = JSON.parse(await readFile(path.join(projectRoot, ".toolspan-dev", "goal-state.json"), "utf8"));
    return { present: true, goalVersion: state.goalVersion ?? null, currentStage: state.currentStage ?? null };
  } catch (error) {
    return {
      present: false,
      goalVersion: null,
      currentStage: "PRECHECK",
      error: error?.code === "ENOENT" ? "MISSING" : "INVALID_JSON",
    };
  }
}

async function detectWebView2() {
  if (!isWindows) return false;
  const candidates = [
    path.join("C:\\", "Program Files (x86)", "Microsoft", "EdgeWebView", "Application"),
    path.join("C:\\", "Program Files", "Microsoft", "EdgeWebView", "Application"),
  ];
  return (await Promise.all(candidates.map(exists))).some(Boolean);
}

function capability(available, reasons) {
  return { available, reasons: available ? [] : reasons };
}

export async function collectPreflight() {
  const npmInvocation = await resolveNpmInvocation();
  const runNpm = (arguments_, options) => npmInvocation === null
    ? Promise.resolve({ available: false, ok: false, timedOut: false, stdout: "", stderr: "" })
    : run(npmInvocation.command, [...npmInvocation.prefix, ...arguments_], options);
  const [
    goalState,
    packagePresent,
    lockfilePresent,
    nodeResult,
    npmResult,
    npmPing,
    npmCiDryRun,
    gitRoot,
    gitStatus,
    gitRemotes,
    rustc,
    cargo,
    rustfmt,
    clippy,
    pwsh,
    windowsPowerShell,
    cloudflared,
    gh,
    ghAuth,
    npmRegistryReachable,
    nodeDocsReachable,
    rustDocsReachable,
    loopbackAvailable,
    desktopCargoPresent,
    desktopPackagePresent,
    namesiloAssetsPresent,
    externalManifestPresent,
    msvcFromPath,
    msvcFromVsWhere,
    webView2Present,
    ...credentialSources
  ] = await Promise.all([
    readGoalStage(),
    exists(path.join(projectRoot, "package.json")),
    exists(path.join(projectRoot, "package-lock.json")),
    run(process.execPath, ["--version"]),
    runNpm(["--version"]),
    runNpm(["ping", "--json", "--fetch-timeout=5000"], { timeoutMilliseconds: 12_000 }),
    runNpm(["ci", "--dry-run", "--ignore-scripts", "--audit=false", "--fund=false"], {
      timeoutMilliseconds: 60_000,
    }),
    run("git", ["rev-parse", "--show-toplevel"]),
    run("git", ["status", "--short"]),
    run("git", ["remote"]),
    run("rustc", ["--version"]),
    run("cargo", ["--version"]),
    run("rustfmt", ["--version"]),
    run("cargo", ["clippy", "--version"]),
    run("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]),
    run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]),
    run("cloudflared", ["--version"]),
    run("gh", ["--version"]),
    run("gh", ["auth", "status", "--active"]),
    fetchReachability("https://registry.npmjs.org/"),
    fetchReachability("https://nodejs.org/docs/latest/api/"),
    fetchReachability("https://doc.rust-lang.org/"),
    canBindLoopback(),
    exists(path.join(projectRoot, "apps", "desktop", "src-tauri", "Cargo.toml")),
    exists(path.join(projectRoot, "apps", "desktop", "package.json")),
    exists(path.join(projectRoot, "vendor-inputs", "namesilo", "marketing-assets.zip")),
    exists(path.join(projectRoot, ".toolspan-dev", "test-environment.json")),
    run(isWindows ? "where.exe" : "which", [isWindows ? "cl.exe" : "cc"]),
    findVisualStudio({ environment: process.env }),
    detectWebView2(),
    ...SECRET_ENVIRONMENT_VARIABLE_NAMES.map(registryNameSources),
  ]);

  const nodeVersion = versionOnly(nodeResult) ?? process.version.replace(/^v/u, "");
  const nodeMeetsCoreMinimum = isNodeAtLeast(nodeVersion);
  const npmVersion = versionOnly(npmResult);
  const rust = {
    rustc: { available: rustc.ok, version: versionOnly(rustc) },
    cargo: { available: cargo.ok, version: versionOnly(cargo) },
    rustfmt: { available: rustfmt.ok, version: versionOnly(rustfmt) },
    clippy: { available: clippy.ok, version: versionOnly(clippy) },
  };
  const rustSourceReady = Object.values(rust).every((item) => item.available);
  const coreReasons = [];
  if (!nodeMeetsCoreMinimum) coreReasons.push("NODE_BELOW_22_17_0");
  if (!npmResult.ok) coreReasons.push("NPM_UNAVAILABLE");
  if (!packagePresent || !lockfilePresent) coreReasons.push("CLEAN_INSTALL_INPUTS_MISSING");
  if (!npmCiDryRun.ok) coreReasons.push(npmCiDryRun.timedOut ? "NPM_CI_DRY_RUN_TIMEOUT" : "NPM_CI_DRY_RUN_FAILED");
  const coreCapable = coreReasons.length === 0;
  const desktopReasons = [];
  if (!coreCapable) desktopReasons.push("CORE_NOT_CAPABLE");
  if (!rustSourceReady) desktopReasons.push("RUST_COMPONENTS_MISSING");
  if (!desktopCargoPresent || !desktopPackagePresent) desktopReasons.push("DESKTOP_SOURCE_NOT_PRESENT");
  const desktopSourceCapable = desktopReasons.length === 0;
  const windowsReasons = [];
  if (!isWindows || process.arch !== "x64") windowsReasons.push("WINDOWS_X64_REQUIRED");
  if (!desktopSourceCapable) windowsReasons.push("DESKTOP_SOURCE_NOT_CAPABLE");
  const msvcBuildToolsDetected = msvcFromPath.ok || msvcFromVsWhere !== null;
  if (!msvcBuildToolsDetected) windowsReasons.push("MSVC_BUILD_TOOLS_NOT_DETECTED");
  if (!webView2Present) windowsReasons.push("WEBVIEW2_NOT_DETECTED");
  const setupReasons = [];
  if (!coreCapable) setupReasons.push("CORE_NOT_CAPABLE");
  if (!loopbackAvailable) setupReasons.push("LOOPBACK_HTTP_UNAVAILABLE");

  const credentialPresence = SECRET_ENVIRONMENT_VARIABLE_NAMES.map((name, index) => ({
    name,
    present: credentialSources[index].length > 0,
    sources: credentialSources[index],
    processRefreshNeeded: !credentialSources[index].includes("processEnvironmentName")
      && credentialSources[index].some((source) => source.endsWith("RegistryName")),
  }));
  const cloudflareCredentialPresent = credentialPresence.some((item) => item.present);
  const cloudflareReasons = [];
  if (!externalManifestPresent) cloudflareReasons.push("TEST_ENVIRONMENT_MANIFEST_MISSING");
  if (!cloudflareCredentialPresent) cloudflareReasons.push("CREDENTIAL_ENVIRONMENT_VARIABLE_NAME_NOT_FOUND");

  const gitChangedFileCount = gitStatus.ok
    ? gitStatus.stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0).length : null;
  const gitRemoteCount = gitRemotes.ok
    ? gitRemotes.stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0).length : 0;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    goalState,
    repository: {
      projectRootDetected: packagePresent,
      gitRepository: gitRoot.ok,
      gitStatusAvailable: gitStatus.ok,
      clean: gitStatus.ok ? gitChangedFileCount === 0 : null,
      changedFileCount: gitChangedFileCount,
      remoteConfigured: gitRemoteCount > 0,
      remoteCount: gitRemoteCount,
    },
    platform: { os: process.platform, architecture: process.arch, release: os.release() },
    runtimes: {
      node: {
        version: nodeVersion === null ? null : `v${nodeVersion}`,
        minimum: "v22.17.0",
        meetsMinimum: nodeMeetsCoreMinimum,
        nodeVersionCommandSucceeded: nodeResult.ok,
      },
      npm: {
        available: npmResult.ok,
        version: npmVersion,
        registryPing: npmPing.ok,
        cleanInstallDryRun: npmCiDryRun.ok,
      },
      rust,
      powershell: {
        pwsh: { available: pwsh.ok, version: versionOnly(pwsh) },
        windowsPowerShell: { available: windowsPowerShell.ok, version: versionOnly(windowsPowerShell) },
      },
      cloudflared: { available: cloudflared.ok, version: versionOnly(cloudflared) },
    },
    nativePrerequisites: {
      desktopPackagePresent,
      desktopCargoPresent,
      msvcBuildToolsDetected,
      msvcDetection: msvcFromPath.ok ? "PATH" : msvcFromVsWhere !== null ? "VSWHERE" : null,
      visualStudioDevShellDetected: msvcFromVsWhere !== null,
      webView2Detected: webView2Present,
    },
    network: {
      npmRegistry: npmRegistryReachable,
      nodeOfficialDocs: nodeDocsReachable,
      rustOfficialDocs: rustDocsReachable,
    },
    github: {
      cliAvailable: gh.ok,
      authenticated: ghAuth.ok,
      repositoryConnected: gitRemoteCount > 0,
      permission: "NOT_CHECKED",
    },
    ownerInputs: {
      namesiloAssetArchivePresent: namesiloAssetsPresent,
      testEnvironmentManifestPresent: externalManifestPresent,
      credentialEnvironmentVariables: credentialPresence,
    },
    capabilityTags: {
      CORE_CAPABLE: coreCapable,
      DESKTOP_SOURCE_CAPABLE: desktopSourceCapable,
      WINDOWS_PACKAGE_CAPABLE: windowsReasons.length === 0,
      SETUP_MOCK_CAPABLE: setupReasons.length === 0,
      EXTERNAL_CLOUDFLARE_CAPABLE: cloudflareReasons.length === 0,
      EXTERNAL_HOST_CAPABLE: false,
    },
    capabilityDetails: {
      CORE_CAPABLE: capability(coreCapable, coreReasons),
      DESKTOP_SOURCE_CAPABLE: capability(desktopSourceCapable, desktopReasons),
      WINDOWS_PACKAGE_CAPABLE: capability(windowsReasons.length === 0, windowsReasons),
      SETUP_MOCK_CAPABLE: capability(setupReasons.length === 0, setupReasons),
      EXTERNAL_CLOUDFLARE_CAPABLE: capability(cloudflareReasons.length === 0, cloudflareReasons),
      EXTERNAL_HOST_CAPABLE: capability(false, ["HOST_ACCOUNT_AND_UI_PERMISSION_REQUIRE_MANUAL_EVIDENCE"]),
    },
  };
}

async function main() {
  try {
    process.stdout.write(`${JSON.stringify(await collectPreflight(), null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      status: "PRECHECK_FAILED",
      error: error instanceof Error ? error.message : "Unknown preflight failure",
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
