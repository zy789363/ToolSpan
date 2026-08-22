import { spawn } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = path.join(projectRoot, "apps", "desktop");
const VERIFICATION_ENVIRONMENT_NAMES = new Set([
  "appdata",
  "cargo_home",
  "ci",
  "comspec",
  "force_color",
  "home",
  "homedrive",
  "homepath",
  "lang",
  "lc_all",
  "lc_ctype",
  "localappdata",
  "no_color",
  "number_of_processors",
  "npm_execpath",
  "npm_node_execpath",
  "os",
  "path",
  "pathext",
  "processor_architecture",
  "processor_identifier",
  "processor_level",
  "processor_revision",
  "programdata",
  "programfiles",
  "programfiles(x86)",
  "programw6432",
  "rustup_home",
  "systemroot",
  "temp",
  "term",
  "tmp",
  "tmpdir",
  "tz",
  "userprofile",
  "windir",
]);
const PROXY_ENVIRONMENT_NAMES = new Set(["all_proxy", "http_proxy", "https_proxy"]);

function proxyHasUserInfo(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return true;
  }
}

export function verificationEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name, value]) => {
    const normalized = name.toLowerCase();
    if (VERIFICATION_ENVIRONMENT_NAMES.has(normalized) || normalized === "no_proxy") return true;
    return PROXY_ENVIRONMENT_NAMES.has(normalized) && !proxyHasUserInfo(value);
  }));
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function environmentValue(environment, name) {
  const key = Object.keys(environment).find((item) => item.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : environment[key];
}

async function executableOnPath(name, environment = process.env) {
  const directories = String(environmentValue(environment, "PATH") ?? "").split(path.delimiter).filter(Boolean);
  const suffixes = process.platform === "win32"
    ? String(environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = path.resolve(directory, process.platform === "win32" ? `${name}${suffix}` : name);
      if (await isFile(candidate)) return candidate;
    }
  }
  return null;
}

export function npmInvocation(npmCli, arguments_) {
  if (typeof npmCli !== "string" || !npmCli.endsWith("npm-cli.js")) {
    throw new Error("A resolved npm-cli.js path is required");
  }
  return {
    command: process.execPath,
    arguments: [npmCli, ...arguments_],
    options: { shell: false, windowsHide: true },
  };
}

export async function resolveNpmCli(environment = process.env) {
  const candidates = [];
  const npmExecPath = environmentValue(environment, "npm_execpath");
  if (typeof npmExecPath === "string") candidates.push(npmExecPath);
  candidates.push(
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    "/usr/share/nodejs/npm/bin/npm-cli.js",
    "/usr/lib/node_modules/npm/bin/npm-cli.js",
  );

  const npmExecutable = await executableOnPath(process.platform === "win32" ? "npm" : "npm", environment);
  if (npmExecutable !== null) {
    try {
      const resolved = await realpath(npmExecutable);
      if (resolved.endsWith("npm-cli.js")) candidates.push(resolved);
      candidates.push(path.join(path.dirname(npmExecutable), "node_modules", "npm", "bin", "npm-cli.js"));
    } catch {
      // Ignore an unreadable PATH entry and continue through explicit candidates.
    }
  }

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.endsWith("npm-cli.js") && await isFile(candidate)) {
      return path.resolve(candidate);
    }
  }
  return null;
}

export async function runDesktopInstall(options = {}) {
  const root = options.projectRoot ?? projectRoot;
  const environment = verificationEnvironment(options.environment ?? process.env);
  const target = path.join(root, "apps", "desktop");
  const manifest = path.join(target, "package.json");
  const lockfile = path.join(target, "package-lock.json");
  try {
    await Promise.all([access(manifest), access(lockfile)]);
  } catch {
    return {
      status: "FAIL",
      classification: "REGRESSION",
      reason: "DESKTOP_PACKAGE_OR_LOCKFILE_MISSING",
      exitCode: 1,
    };
  }

  const npmCli = options.npmCli ?? await resolveNpmCli(environment);
  if (npmCli === null) {
    return {
      status: "BLOCKED_BY_ENVIRONMENT",
      reason: "NPM_CLI_NOT_FOUND",
      exitCode: 2,
    };
  }

  const invocation = npmInvocation(npmCli, ["ci", "--prefix", target, "--audit=false", "--fund=false"]);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.arguments, {
      cwd: root,
      env: environment,
      ...invocation.options,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", resolve);
  });
  return code === 0
    ? { status: "PASS", checks: ["DESKTOP_CLEAN_INSTALL"], exitCode: 0 }
    : { status: "FAIL", classification: "REGRESSION", reason: "NPM_CI_FAILED", exitCode: 1 };
}

async function main() {
  try {
    const result = await runDesktopInstall();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      status: "BLOCKED_BY_ENVIRONMENT",
      reason: error?.code === "ENOENT" ? "PROCESS_EXECUTABLE_NOT_FOUND" : "DESKTOP_INSTALL_FAILED",
    })}\n`);
    process.exitCode = error?.code === "ENOENT" ? 2 : 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
