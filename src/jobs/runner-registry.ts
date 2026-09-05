import { constants, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

import type { RunnerDefinition } from "./job-service.js";

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "diff",
  "grep",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status",
]);

const READ_ONLY_SVN_SUBCOMMANDS = new Set(["diff", "info", "log", "status"]);

const FORBIDDEN_GIT_OPTIONS = new Set([
  "--ext-diff",
  "--textconv",
  "--open-files-in-pager",
  "--output",
  "-o",
]);

const FORBIDDEN_PACKAGE_OPTIONS = new Set([
  "--global",
  "-g",
  "--prefix",
  "--script-shell",
  "--globalconfig",
  "--userconfig",
]);

const FORBIDDEN_SVN_OPTIONS = new Set([
  "--config-dir",
  "--config-option",
  "--diff",
  "--diff-cmd",
  "--diff3-cmd",
  "--editor-cmd",
  "--extensions",
  "--force-interactive",
  "--include-externals",
  "--password",
  "--targets",
  "--trust-server-cert",
  "--trust-server-cert-failures",
  "--username",
  "-x",
]);

const WINDOWS_RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))(?:\..*)?$/iu;

function isUnsafePathValue(value: string): boolean {
  return path.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || path.posix.isAbsolute(value)
    || /^[A-Za-z]:/u.test(value)
    || /^(?:\\\\|\/\/)/u.test(value)
    || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value)
    || value.split(/[\\/]+/u).some((segment) => WINDOWS_RESERVED_DEVICE_NAME.test(segment));
}

function hasSafeArguments(args: readonly string[]): boolean {
  return args.every(
    (argument) => {
      const equals = argument.indexOf("=");
      const assignedValue = equals < 0 ? undefined : argument.slice(equals + 1);
      return argument.length > 0 &&
      argument.length <= 4096 &&
      !argument.includes("\0") &&
      !argument.includes("\r") &&
      !argument.includes("\n") &&
      !isUnsafePathValue(argument) &&
      (assignedValue === undefined || !isUnsafePathValue(assignedValue));
    },
  );
}

function coreEnvironment(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ["PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", "ComSpec"]) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  result.GIT_TERMINAL_PROMPT = "0";
  result.GIT_OPTIONAL_LOCKS = "0";
  result.GIT_PAGER = "cat";
  result.PAGER = "cat";
  return result;
}

function commandValidator(commands: readonly string[]): (args: readonly string[]) => boolean {
  const allowed = new Set(commands);
  return (args) => hasSafeArguments(args) && args[0] !== undefined && allowed.has(args[0]);
}

function packageCommandValidator(commands: readonly string[]): (args: readonly string[]) => boolean {
  const commandAllowed = commandValidator(commands);
  return (args) => commandAllowed(args) && !args.some((argument) => {
    const [option] = argument.split("=", 1);
    return option !== undefined && FORBIDDEN_PACKAGE_OPTIONS.has(option);
  });
}

function optionName(argument: string): string {
  const equals = argument.indexOf("=");
  return equals < 0 ? argument : argument.slice(0, equals);
}

function svnCommandValidator(args: readonly string[]): boolean {
  const subcommand = args[0];
  const commandArguments = args.slice(1);
  const summarizesDiff = subcommand === "diff" && commandArguments.includes("--summarize");
  const selectsInternalDiff = commandArguments.includes("--internal-diff");
  const managedFlags = ["--internal-diff", "--non-interactive", "--summarize"];
  const hasMalformedManagedFlag = commandArguments.some((argument) =>
    managedFlags.includes(optionName(argument)) && !managedFlags.includes(argument),
  );
  const hasDuplicateManagedFlag = managedFlags.some((flag) =>
    commandArguments.filter((argument) => argument === flag).length > 1,
  );
  const hasXmlWithoutSummary = subcommand === "diff"
    && commandArguments.includes("--xml")
    && !summarizesDiff;
  return hasSafeArguments(args)
    && subcommand !== undefined
    && READ_ONLY_SVN_SUBCOMMANDS.has(subcommand)
    && !hasMalformedManagedFlag
    && !hasDuplicateManagedFlag
    && !hasXmlWithoutSummary
    && !(summarizesDiff && selectsInternalDiff)
    && !(subcommand !== "diff" && (commandArguments.includes("--summarize") || selectsInternalDiff))
    && !args.slice(1).some((argument) => {
      const option = optionName(argument);
      return FORBIDDEN_SVN_OPTIONS.has(option)
        || argument.startsWith("-x")
        || /(?:^|=)[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(argument)
        || /^\^[/\\]/u.test(argument);
    });
}

function executableOnPath(name: string): string | undefined {
  for (const directoryValue of (process.env.PATH ?? "").split(path.delimiter)) {
    const directory = directoryValue.trim().replace(/^"|"$/gu, "");
    if (directory.length === 0) continue;
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function svnExecutable(): string {
  if (process.platform !== "win32") return "svn";
  const configured = process.env.TOOLSPAN_SVN_PATH?.trim();
  if (configured !== undefined && path.isAbsolute(configured) && existsSync(configured)) return configured;
  const fromPath = executableOnPath("svn.exe");
  if (fromPath !== undefined) return fromPath;
  const candidates = [
    process.env.ProgramFiles === undefined
      ? undefined
      : path.join(process.env.ProgramFiles, "TortoiseSVN", "bin", "svn.exe"),
    process.env["ProgramFiles(x86)"] === undefined
      ? undefined
      : path.join(process.env["ProgramFiles(x86)"], "TortoiseSVN", "bin", "svn.exe"),
    process.env.ProgramFiles === undefined
      ? undefined
      : path.join(process.env.ProgramFiles, "SlikSvn", "bin", "svn.exe"),
    process.env["ProgramFiles(x86)"] === undefined
      ? undefined
      : path.join(process.env["ProgramFiles(x86)"], "SlikSvn", "bin", "svn.exe"),
    process.env.ProgramFiles === undefined
      ? undefined
      : path.join(process.env.ProgramFiles, "VisualSVN Server", "bin", "svn.exe"),
  ];
  return candidates.find((candidate) => candidate !== undefined && existsSync(candidate)) ?? "svn.exe";
}

function resolveSvnCommand(executablePath: string, args: readonly string[]): {
  executable: string;
  args: string[];
} {
  const commandArgs = [args[0]!];
  if (!args.slice(1).includes("--non-interactive")) commandArgs.push("--non-interactive");
  const summarizesDiff = args[0] === "diff" && args.slice(1).includes("--summarize");
  if (args[0] === "diff" && !summarizesDiff && !args.slice(1).includes("--internal-diff")) {
    commandArgs.push("--internal-diff");
  }
  commandArgs.push(...args.slice(1));
  return { executable: executablePath, args: commandArgs };
}

function executable(name: string): string {
  return process.platform === "win32" && ["npm", "pnpm", "yarn"].includes(name)
    ? `${name}.cmd`
    : name;
}

function lifecyclePackageManagerCli(name: "npm" | "pnpm" | "yarn"): string | undefined {
  const candidate = process.env.npm_execpath;
  if (candidate === undefined || !path.isAbsolute(candidate)) return undefined;
  const normalized = path.normalize(candidate);
  const suffix = normalized.toLowerCase();
  const hasPathSuffix = (...parts: string[]): boolean =>
    suffix.endsWith(`${path.sep}${path.join(...parts).toLowerCase()}`);
  if (name === "npm") {
    if (hasPathSuffix("node_modules", "npm", "bin", "npm-cli.js")) return normalized;
    if (hasPathSuffix("node_modules", "npm", "bin", "npx-cli.js")) {
      return path.join(path.dirname(normalized), "npm-cli.js");
    }
  }
  return hasPathSuffix("node_modules", "corepack", "dist", `${name}.js`) ? normalized : undefined;
}

function packageManagerCli(name: "npm" | "pnpm" | "yarn"): string | undefined {
  if (process.platform !== "win32") return undefined;
  const lifecycleCli = lifecyclePackageManagerCli(name);
  if (lifecycleCli !== undefined) return lifecycleCli;
  const nodeModules = path.join(path.dirname(process.execPath), "node_modules");
  return name === "npm"
    ? path.join(nodeModules, "npm", "bin", "npm-cli.js")
    : path.join(nodeModules, "corepack", "dist", `${name}.js`);
}

async function locateCorepackCli(name: "pnpm" | "yarn"): Promise<string | undefined> {
  const wrappers = await new Promise<string[]>((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (result: string[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const child = spawn("where.exe", ["corepack.cmd"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timeout = setTimeout(() => {
      child.kill();
      finish([]);
    }, 3000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 16_384) stdout += String(chunk);
    });
    child.once("error", () => finish([]));
    child.once("close", (code) => finish(code === 0 ? stdout.split(/\r?\n/u) : []));
  });

  for (const wrapper of wrappers) {
    const candidate = wrapper.trim();
    if (!path.isAbsolute(candidate) || path.basename(candidate).toLowerCase() !== "corepack.cmd") continue;
    const cli = path.join(path.dirname(candidate), "node_modules", "corepack", "dist", `${name}.js`);
    try {
      await access(cli, constants.R_OK);
      return cli;
    } catch {
      // Try another exact corepack shim reported by the OS locator.
    }
  }
  return undefined;
}

async function resolvePackageManager(
  name: "npm" | "pnpm" | "yarn",
  args: readonly string[],
): Promise<{ executable: string; args: string[] }> {
  if (process.platform !== "win32") return { executable: name, args: [...args] };
  const cli = packageManagerCli(name);
  if (cli !== undefined) {
    try {
      await access(cli, constants.R_OK);
      return { executable: process.execPath, args: [cli, ...args] };
    } catch {
      // A separately installed Node runtime may need the system Corepack entry point.
    }
  }
  if (name !== "npm") {
    const corepackCli = await locateCorepackCli(name);
    if (corepackCli !== undefined) {
      return { executable: process.execPath, args: [corepackCli, ...args] };
    }
  }
  throw new Error(`${name} JavaScript entry point is not available`);
}

async function resolvePytest(args: readonly string[], cwd: string): Promise<{
  executable: string;
  args: string[];
}> {
  for (const environmentName of [".venv", "venv"]) {
    const candidate = process.platform === "win32"
      ? path.join(cwd, environmentName, "Scripts", "pytest.exe")
      : path.join(cwd, environmentName, "bin", "pytest");
    try {
      await access(candidate, constants.X_OK);
      return { executable: candidate, args: [...args] };
    } catch {
      // Try the other conventional workspace-local environment.
    }
  }
  return {
    executable: process.platform === "win32" ? "pytest.exe" : "pytest",
    args: [...args],
  };
}

export function createProductionRunners(): Record<string, RunnerDefinition> {
  const environment = coreEnvironment();
  const svnExecutablePath = svnExecutable();
  return {
    shell: {
      executable: "git",
      validateArgs: (args) =>
        hasSafeArguments(args) &&
        args[0] === "git" &&
        args[1] !== undefined &&
        READ_ONLY_GIT_SUBCOMMANDS.has(args[1]) &&
        !args.slice(2).some((argument) => {
          const [option] = argument.split("=", 1);
          return option !== undefined && FORBIDDEN_GIT_OPTIONS.has(option);
        }),
      resolveCommand: (args) => ({ executable: "git", args: args.slice(1) }),
      maxConcurrent: 4,
      maxConcurrentPerWorkspace: 4,
      maxTimeoutSeconds: 60,
      maxOutputBytes: 1024 * 1024,
      environment,
    },
    svn: {
      executable: svnExecutablePath,
      validateArgs: svnCommandValidator,
      resolveCommand: (args) => resolveSvnCommand(svnExecutablePath, args),
      maxConcurrent: 4,
      maxConcurrentPerWorkspace: 2,
      maxTimeoutSeconds: 5 * 60,
      maxOutputBytes: 4 * 1024 * 1024,
      environment,
    },
    pytest: {
      executable: process.platform === "win32" ? "pytest.exe" : "pytest",
      validateArgs: hasSafeArguments,
      resolveCommand: resolvePytest,
      maxConcurrent: 2,
      maxConcurrentPerWorkspace: 1,
      maxTimeoutSeconds: 15 * 60,
      maxOutputBytes: 4 * 1024 * 1024,
      environment,
    },
    blender: {
      executable: process.platform === "win32" ? "blender.exe" : "blender",
      prefixArgs: ["--disable-autoexec"],
      validateArgs: (args) =>
        hasSafeArguments(args) &&
        args.includes("--background") &&
        !args.some((argument) =>
          argument.startsWith("--python") ||
          ["--addons", "--enable-autoexec", "--command"].includes(optionName(argument)),
        ),
      maxConcurrent: 1,
      maxConcurrentPerWorkspace: 1,
      maxTimeoutSeconds: 30 * 60,
      maxOutputBytes: 8 * 1024 * 1024,
      environment,
    },
    npm: {
      executable: process.platform === "win32" ? process.execPath : executable("npm"),
      validateArgs: packageCommandValidator(["ci", "install", "run", "test"]),
      resolveCommand: (args) => resolvePackageManager("npm", args),
      maxConcurrent: 1,
      maxConcurrentPerWorkspace: 1,
      maxTimeoutSeconds: 15 * 60,
      maxOutputBytes: 4 * 1024 * 1024,
      environment,
      requiredFiles: packageManagerCli("npm") === undefined ? [] : [packageManagerCli("npm")!],
    },
    pnpm: {
      executable: process.platform === "win32" ? process.execPath : executable("pnpm"),
      validateArgs: packageCommandValidator(["install", "run", "test"]),
      resolveCommand: (args) => resolvePackageManager("pnpm", args),
      maxConcurrent: 1,
      maxConcurrentPerWorkspace: 1,
      maxTimeoutSeconds: 15 * 60,
      maxOutputBytes: 4 * 1024 * 1024,
      environment,
      requiredFiles: packageManagerCli("pnpm") === undefined ? [] : [packageManagerCli("pnpm")!],
    },
    yarn: {
      executable: process.platform === "win32" ? process.execPath : executable("yarn"),
      validateArgs: packageCommandValidator(["install", "run", "test"]),
      resolveCommand: (args) => resolvePackageManager("yarn", args),
      maxConcurrent: 1,
      maxConcurrentPerWorkspace: 1,
      maxTimeoutSeconds: 15 * 60,
      maxOutputBytes: 4 * 1024 * 1024,
      environment,
      requiredFiles: packageManagerCli("yarn") === undefined ? [] : [packageManagerCli("yarn")!],
    },
    cargo: {
      executable: process.platform === "win32" ? "cargo.exe" : "cargo",
      validateArgs: commandValidator(["build", "check", "clippy", "fmt", "test"]),
      maxConcurrent: 2,
      maxConcurrentPerWorkspace: 1,
      maxTimeoutSeconds: 20 * 60,
      maxOutputBytes: 4 * 1024 * 1024,
      environment,
    },
    dotnet: {
      executable: process.platform === "win32" ? "dotnet.exe" : "dotnet",
      validateArgs: commandValidator(["build", "format", "restore", "test"]),
      maxConcurrent: 2,
      maxConcurrentPerWorkspace: 1,
      maxTimeoutSeconds: 20 * 60,
      maxOutputBytes: 4 * 1024 * 1024,
      environment,
    },
  };
}

async function executableIsAvailable(candidate: string): Promise<boolean> {
  if (path.isAbsolute(candidate)) {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const locator = process.platform === "win32" ? "where.exe" : "which";
  return new Promise((resolve) => {
    const child = spawn(locator, [candidate], { shell: false, windowsHide: true, stdio: "ignore" });
    const timeout = setTimeout(() => child.kill(), 3000);
    child.once("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}

export async function inspectRunnerAvailability(
  runners: Readonly<Record<string, RunnerDefinition>>,
): Promise<Array<{ name: string; available: boolean }>> {
  return Promise.all(
    Object.entries(runners)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([name, runner]) => ({
        name,
        available: await executableIsAvailable(runner.executable) && (
          await Promise.all((runner.requiredFiles ?? []).map(async (file) => {
            try {
              await access(file, constants.R_OK);
              return true;
            } catch {
              return false;
            }
          }))
        ).every(Boolean),
      })),
  );
}
