import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const safeEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/(?:secret|password|token|api.?key|private.?key|credential)/iu.test(name)));

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function npmCli() {
  if (typeof process.env.npm_execpath === "string" && await exists(process.env.npm_execpath)) {
    return process.env.npm_execpath;
  }
  const candidate = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return await exists(candidate) ? candidate : null;
}

async function execute(command, arguments_, options = {}) {
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? projectRoot,
      env: options.env ?? safeEnvironment,
      shell: false,
      windowsHide: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill(), options.timeoutMilliseconds ?? 120_000);
    child.stdout?.on("data", (chunk) => { if (stdout.length < 1_000_000) stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { if (stderr.length < 1_000_000) stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port"));
        return;
      }
      server.close((error) => error === undefined ? resolve(address.port) : reject(error));
    });
  });
}

function forbiddenPackagePath(filePath) {
  const legacyConfigName = new RegExp(`(?:^|/)(?:toolspan|${["web", "gpt"].join("")})\\.config\\.json$`, "iu");
  return /^(?:\.git|\.toolspan-dev|node_modules|src|tests|coverage|state|secrets)(?:\/|$)/iu.test(filePath)
    || legacyConfigName.test(filePath)
    || /(?:^|\/)(?:owner\.bcrypt|preview-secret\.bin|\.env|\.npmrc)$/iu.test(filePath)
    || /\.(?:log|pem|key|pfx)$/iu.test(filePath);
}

function validateManifest(files, allowlist) {
  const errors = [];
  const names = files.map((file) => file.path.replaceAll("\\", "/"));
  for (const required of allowlist.required) {
    if (!names.includes(required)) errors.push(`missing required release file: ${required}`);
  }
  for (const name of names) {
    const allowed = allowlist.allowedExact.includes(name)
      || allowlist.allowedPrefixes.some((prefix) => name.startsWith(prefix));
    if (!allowed) errors.push(`release file is outside the allowlist: ${name}`);
    if (forbiddenPackagePath(name)) errors.push(`forbidden release file: ${name}`);
  }
  return errors;
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Packed server exited before health check");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return await response.json();
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Packed server health check timed out");
}

let temporaryDirectory;
let serverChild;
try {
  const npmExecPath = await npmCli();
  if (npmExecPath === null) throw new Error("Could not locate npm CLI without using a command shell");
  const npm = async (arguments_, options = {}) => await execute(
    process.execPath, [npmExecPath, ...arguments_], options,
  );
  const build = await npm(["run", "build"]);
  if (!build.ok) throw new Error(`build failed with exit code ${String(build.code)}`);

  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "toolspan-release-smoke-"));
  const packed = await npm([
    "pack", "--json", "--ignore-scripts", "--pack-destination", temporaryDirectory,
  ]);
  if (!packed.ok) throw new Error(`npm pack failed with exit code ${String(packed.code)}`);
  let packResult;
  try { [packResult] = JSON.parse(packed.stdout); } catch { throw new Error("npm pack did not return valid JSON"); }
  if (packResult === undefined || !Array.isArray(packResult.files)) throw new Error("npm pack manifest is missing");
  const allowlist = JSON.parse(await readFile(path.join(projectRoot, "scripts", "release-package-allowlist.json"), "utf8"));
  const manifestErrors = validateManifest(packResult.files, allowlist);
  if (manifestErrors.length > 0) throw new Error(manifestErrors.join("; "));

  const consumer = path.join(temporaryDirectory, "consumer");
  await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"), "{\"private\":true,\"type\":\"module\"}\n");
  const tarball = path.join(temporaryDirectory, packResult.filename);
  const installed = await npm([
    "install", "--ignore-scripts", "--omit=dev", "--audit=false", "--fund=false", tarball,
  ], { cwd: consumer, timeoutMilliseconds: 300_000 });
  if (!installed.ok) {
    throw new Error(
      `production install failed with exit code ${String(installed.code)}`
      + (installed.stderr ? `\n${installed.stderr.slice(-2000)}` : ""),
    );
  }

  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const installedRoot = path.join(consumer, "node_modules", ...packageJson.name.split("/"));
  const passwordFile = path.join(temporaryDirectory, "runtime", "owner.bcrypt");
  const password = `${randomBytes(24).toString("base64url")}!a1`;
  const passwordResult = await execute(process.execPath, [
    path.join(installedRoot, "dist", "cli", "init-password.js"), "--file", passwordFile,
  ], { cwd: installedRoot, input: `${password}\n` });
  if (!passwordResult.ok) throw new Error(`compiled password:init failed with exit code ${String(passwordResult.code)}`);

  const projects = path.join(temporaryDirectory, "projects");
  await mkdir(projects);
  const port = await availablePort();
  const configPath = path.join(temporaryDirectory, "toolspan.config.json");
  await writeFile(configPath, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    publicBaseUrl: `http://127.0.0.1:${String(port)}`,
    allowedRoots: [projects],
    stateDirectory: path.join(temporaryDirectory, "runtime", "state"),
    ownerPasswordHashFile: passwordFile,
    instanceName: "release-smoke",
  }, null, 2)}\n`);
  const doctor = await execute(process.execPath, [
    path.join(installedRoot, "dist", "cli", "doctor.js"), "--config", configPath,
  ], { cwd: installedRoot });
  if (!doctor.ok) throw new Error(`compiled doctor failed with exit code ${String(doctor.code)}`);

  serverChild = spawn(process.execPath, [path.join(installedRoot, "dist", "main.js"), "--config", configPath], {
    cwd: installedRoot,
    env: safeEnvironment,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverChild.stdout?.resume();
  serverChild.stderr?.resume();
  const health = await waitForHealth(`http://127.0.0.1:${String(port)}/healthz`, serverChild);
  const keys = Object.keys(health).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["service", "status", "version"])) {
    throw new Error("public health response contains unexpected fields");
  }
  if (health.status !== "ok" || health.service !== "toolspan" || health.version !== packageJson.version) {
    throw new Error("public health response does not match canonical Service Info");
  }
  serverChild.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (serverChild.exitCode === null) serverChild.kill();
      resolve();
    }, 5_000);
    serverChild.once("close", () => { clearTimeout(timer); resolve(); });
  });
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    package: `${packageJson.name}@${packageJson.version}`,
    packagedFileCount: packResult.files.length,
    productionInstall: "PASS",
    compiledPasswordInit: "PASS",
    compiledDoctor: "PASS",
    compiledStartAndHealth: "PASS",
    cleanup: "PASS",
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`[smoke:core-release] ${error instanceof Error ? error.message : "release smoke failed"}\n`);
  process.exitCode = 1;
} finally {
  if (serverChild?.exitCode === null) serverChild.kill();
  if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
}
