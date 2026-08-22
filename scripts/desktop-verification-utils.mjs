import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { npmInvocation, resolveNpmCli } from "./desktop-install.mjs";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const desktopRoot = path.join(projectRoot, "apps", "desktop");
export const cargoManifest = path.join(desktopRoot, "src-tauri", "Cargo.toml");

export function isSupportedDesktopNodeVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(String(value).trim());
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 22 && minor >= 17) || major === 24;
}

export async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export async function isDirectory(filePath) {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

export function executableCandidates(name, environment = process.env, platform = process.platform) {
  const value = (key) => {
    const actual = Object.keys(environment).find((item) => item.toLowerCase() === key.toLowerCase());
    return actual === undefined ? undefined : environment[actual];
  };
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const directories = String(value("PATH") ?? "").split(pathApi.delimiter).filter(Boolean);
  const suffixes = platform === "win32"
    ? String(value("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  return directories.flatMap((directory) => suffixes.map((suffix) => pathApi.resolve(
    directory,
    platform === "win32" ? `${name}${suffix}` : name,
  )));
}

export async function resolveExecutable(name, options = {}) {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const candidates = [
    ...(options.explicitCandidates ?? []),
    ...executableCandidates(name, options.environment ?? process.env, platform),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && await isFile(candidate)) return pathApi.resolve(candidate);
  }
  return null;
}

export async function runProcess(command, arguments_ = [], options = {}) {
  const capture = options.capture === true;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 0;
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    let child;
    try {
      child = spawn(command, arguments_, {
        cwd: options.cwd ?? projectRoot,
        env: options.environment ?? process.env,
        shell: false,
        windowsHide: true,
        stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      });
    } catch (error) {
      finish({ started: false, code: null, signal: null, errorCode: error?.code ?? "SPAWN_FAILED" });
      return;
    }
    if (capture) {
      child.stdout?.on("data", (chunk) => {
        if (stdout.length < 65_536) stdout += String(chunk).slice(0, 65_536 - stdout.length);
      });
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 65_536) stderr += String(chunk).slice(0, 65_536 - stderr.length);
      });
    }
    if (timeoutMilliseconds > 0) {
      timer = setTimeout(() => {
        child.kill();
        finish({ started: true, code: null, signal: "TIMEOUT", errorCode: "PROCESS_TIMEOUT" });
      }, timeoutMilliseconds);
    }
    child.once("error", (error) => finish({
      started: false,
      code: null,
      signal: null,
      errorCode: error?.code ?? "SPAWN_FAILED",
    }));
    child.once("close", (code, signal) => finish({
      started: true,
      code,
      signal,
      errorCode: null,
    }));
  });
}

export async function requireSuccessfulProcess(label, command, arguments_, options = {}) {
  process.stdout.write(`[desktop:verify] ${label}\n`);
  const result = await (options.runner ?? runProcess)(command, arguments_, options);
  if (!result.started || result.code !== 0) {
    const error = new Error(`${label} failed`);
    error.code = result.errorCode ?? "PROCESS_FAILED";
    error.exitCode = result.code;
    throw error;
  }
  return result;
}

export async function npmCommand(arguments_, options = {}) {
  const npmCli = options.npmCli ?? await resolveNpmCli(options.environment ?? process.env);
  if (npmCli === null) {
    const error = new Error("npm CLI was not found");
    error.code = "NPM_CLI_NOT_FOUND";
    throw error;
  }
  const invocation = npmInvocation(npmCli, arguments_);
  return await requireSuccessfulProcess(
    options.label ?? `npm ${arguments_.join(" ")}`,
    invocation.command,
    invocation.arguments,
    { ...invocation.options, ...options },
  );
}

export function vsWhereCandidates(environment = process.env) {
  const roots = [environment["ProgramFiles(x86)"], environment.ProgramFiles]
    .filter((item) => typeof item === "string" && item.length > 0);
  return [...new Set(roots.map((root) => path.win32.join(root, "Microsoft Visual Studio", "Installer", "vswhere.exe")))];
}

export function parseVsWhereInstallationPath(stdout) {
  const lines = String(stdout).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1 || !path.win32.isAbsolute(lines[0])) return null;
  return path.win32.normalize(lines[0]);
}

export async function findVisualStudio(options = {}) {
  if ((options.platform ?? process.platform) !== "win32") return null;
  const environment = options.environment ?? process.env;
  const vswhere = await resolveExecutable("vswhere", {
    environment,
    platform: "win32",
    explicitCandidates: options.vswhereCandidates ?? vsWhereCandidates(environment),
  });
  if (vswhere === null) return null;
  const result = await (options.runner ?? runProcess)(vswhere, [
    "-latest",
    "-products", "*",
    "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property", "installationPath",
  ], { capture: true, timeoutMilliseconds: 10_000, environment });
  if (!result.started || result.code !== 0) return null;
  const installationPath = parseVsWhereInstallationPath(result.stdout);
  if (installationPath === null) return null;
  const launchVsDevShell = path.win32.join(installationPath, "Common7", "Tools", "Launch-VsDevShell.ps1");
  if (!await (options.isFile ?? isFile)(launchVsDevShell)) return null;
  return { vswhere, launchVsDevShell };
}

export async function resolveWindowsPowerShell(environment = process.env) {
  const systemRoot = environment.SystemRoot ?? "C:\\Windows";
  return await resolveExecutable("powershell", {
    environment,
    platform: "win32",
    explicitCandidates: [path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")],
  });
}

export async function runVisualStudioOperation(operation, options = {}) {
  const allowed = new Set(["probe", "fmt", "check", "clippy", "test", "tauri-build"]);
  if (!allowed.has(operation)) throw new Error(`Unsupported Visual Studio operation: ${operation}`);
  const environment = options.environment ?? process.env;
  const visualStudio = options.visualStudio ?? await findVisualStudio({ environment });
  const powershell = options.powershell ?? await resolveWindowsPowerShell(environment);
  if (visualStudio === null || powershell === null) {
    const error = new Error("Visual Studio developer shell is unavailable");
    error.code = "MSVC_BUILD_TOOLS_NOT_DETECTED";
    throw error;
  }
  const arguments_ = [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(projectRoot, "scripts", "invoke-desktop-vs.ps1"),
    "-Operation", operation,
    "-LaunchVsDevShell", visualStudio.launchVsDevShell,
  ];
  if (operation === "tauri-build") {
    const npmCli = options.npmCli ?? await resolveNpmCli(environment);
    if (npmCli === null) {
      const error = new Error("npm CLI was not found");
      error.code = "NPM_CLI_NOT_FOUND";
      throw error;
    }
    arguments_.push("-NodePath", process.execPath, "-NpmCliPath", npmCli);
  }
  return await requireSuccessfulProcess(
    options.label ?? `Visual Studio ${operation}`,
    powershell,
    arguments_,
    { ...options, environment },
  );
}

export async function runCargoOperation(operation, options = {}) {
  if (!["fmt", "check", "clippy", "test"].includes(operation)) {
    throw new Error(`Unsupported Cargo operation: ${operation}`);
  }
  if ((options.platform ?? process.platform) === "win32") {
    return await runVisualStudioOperation(operation, options);
  }
  const argumentsByOperation = {
    fmt: ["fmt", "--manifest-path", cargoManifest, "--", "--check"],
    check: ["check", "--locked", "--manifest-path", cargoManifest],
    clippy: ["clippy", "--locked", "--manifest-path", cargoManifest, "--all-targets", "--", "-D", "warnings"],
    test: ["test", "--locked", "--manifest-path", cargoManifest],
  };
  return await requireSuccessfulProcess(
    options.label ?? `cargo ${operation}`,
    options.cargo ?? "cargo",
    argumentsByOperation[operation],
    options,
  );
}

export async function detectWebView2(options = {}) {
  if ((options.platform ?? process.platform) !== "win32") return false;
  const environment = options.environment ?? process.env;
  const directoryCandidates = [
    path.join(environment["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "EdgeWebView", "Application"),
    path.join(environment.ProgramFiles ?? "C:\\Program Files", "Microsoft", "EdgeWebView", "Application"),
    ...(typeof environment.LOCALAPPDATA === "string" && environment.LOCALAPPDATA.length > 0
      ? [path.join(environment.LOCALAPPDATA, "Microsoft", "EdgeWebView", "Application")]
      : []),
  ];
  for (const candidate of directoryCandidates) {
    if (!await (options.isDirectory ?? isDirectory)(candidate)) continue;
    if (await (options.isFile ?? isFile)(path.join(candidate, "msedgewebview2.exe"))) return true;
    try {
      const entries = await readdir(candidate, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()
          && await (options.isFile ?? isFile)(path.join(candidate, entry.name, "msedgewebview2.exe"))) return true;
      }
    } catch {
      // Continue to the registry probes when an installation directory is unreadable.
    }
  }
  const reg = options.reg ?? await resolveExecutable("reg", {
    environment,
    platform: "win32",
    explicitCandidates: [path.join(environment.SystemRoot ?? "C:\\Windows", "System32", "reg.exe")],
  });
  if (reg === null) return false;
  const clientId = "{F1E7E4D7-9D6F-4CE7-8B67-5D687F0F2F88}";
  const keys = [
    `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${clientId}`,
    `HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${clientId}`,
    `HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${clientId}`,
  ];
  for (const key of keys) {
    const result = await (options.runner ?? runProcess)(reg, ["query", key, "/v", "pv"], {
      capture: true,
      timeoutMilliseconds: 5_000,
      environment,
    });
    if (result.started && result.code === 0) return true;
  }
  return false;
}

export async function resolveCscript(environment = process.env) {
  return await resolveExecutable("cscript", {
    environment,
    platform: "win32",
    explicitCandidates: [path.join(environment.SystemRoot ?? "C:\\Windows", "System32", "cscript.exe")],
  });
}

export async function findBundleArtifacts(options = {}) {
  const root = options.root ?? path.join(desktopRoot, "src-tauri", "target", "release", "bundle");
  const version = options.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) return [];
  const expected = [
    path.join(root, "msi", `ToolSpan_${version}_x64_en-US.msi`),
    path.join(root, "nsis", `ToolSpan_${version}_x64-setup.exe`),
  ];
  const artifacts = [];
  for (const artifactPath of expected) {
    if (!await isFile(artifactPath)) continue;
    const relativePath = path.relative(projectRoot, artifactPath);
    if (path.isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${path.sep}`)) {
      continue;
    }
    const [contents, metadata] = await Promise.all([readFile(artifactPath), stat(artifactPath)]);
    artifacts.push({
      path: relativePath.split(path.sep).join("/"),
      bytes: metadata.size,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  return artifacts;
}

export async function assertReadable(filePath, reason) {
  try {
    await access(filePath);
  } catch {
    const error = new Error(reason);
    error.code = reason;
    throw error;
  }
}
