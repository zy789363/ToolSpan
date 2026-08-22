import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EXPECTED_TOOLS } from "./e2e-mcp-inspector.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const fixtureRoot = path.join(repositoryRoot, "tests", "e2e-fixtures", "remote-workspace");
const cloudflaredPath = path.join(repositoryRoot, ".toolspan-dev", "bin", "cloudflared.exe");
const cloudflaredSha256 = "c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5";
const codexScriptPath = path.join(
  process.env.APPDATA ?? "",
  "npm",
  "node_modules",
  "@openai",
  "codex",
  "bin",
  "codex.js",
);
const fullScopes = ["workspace:read", "workspace:write", "jobs:run", "artifacts:publish"];
let codexCommand;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isMissing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function nonSecretEnvironment(extra = {}) {
  const allowedNames = new Set([
    "APPDATA",
    "CODEX_HOME",
    "COMSPEC",
    "HOME",
    "LOCALAPPDATA",
    "NODE",
    "NODE_NO_WARNINGS",
    "NUMBER_OF_PROCESSORS",
    "NPM_EXECPATH",
    "NPM_NODE_EXECPATH",
    "OS",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
  ]);
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && allowedNames.has(name.toUpperCase())) environment[name] = value;
  }
  return { ...environment, ...extra };
}

function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? nonSecretEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let callbackError;
    let timedOut = false;
    const append = (current, chunk) => current.length >= 4 * 1024 * 1024
      ? current
      : `${current}${chunk}`.slice(0, 4 * 1024 * 1024);
    const call = (handler, chunk) => {
      if (handler === undefined || callbackError !== undefined) return;
      try {
        Promise.resolve(handler(chunk)).catch((error) => {
          callbackError = error;
          child.kill();
        });
      } catch (error) {
        callbackError = error;
        child.kill();
      }
    };
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
      call(options.onStdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
      call(options.onStderr, chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      if (callbackError !== undefined) return reject(callbackError);
      if (timedOut) {
        const error = new Error(`${options.label ?? "CHILD"}_TIMEOUT`);
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }
      const allowedExitCodes = options.allowedExitCodes ?? [0];
      if (!allowedExitCodes.includes(code)) {
        const error = new Error(`${options.label ?? "CHILD"}_EXIT_${String(code)}${signal === null ? "" : `_${signal}`}`);
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout, stderr, code, signal });
    });
    child.stdin.end(options.input);
  });
}

function startManagedProcess(executable, args, options = {}) {
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env ?? nonSecretEnvironment(),
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-512 * 1024);
    options.onOutput?.(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-512 * 1024);
    options.onOutput?.(chunk);
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, closed, output: () => `${stdout}\n${stderr}` };
}

async function stopManagedProcess(managed) {
  if (managed === undefined || managed.child.exitCode !== null) return;
  managed.child.kill();
  await Promise.race([
    managed.closed,
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  if (managed.child.exitCode === null) managed.child.kill();
}

async function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate) => typeof candidate === "string" && path.isAbsolute(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Try the next exact npm JavaScript entry point.
    }
  }
  throw new Error("NPM_CLI_UNAVAILABLE");
}

async function runNpm(args, cwd) {
  return runProcess(process.execPath, [await npmCliPath(), ...args], {
    cwd,
    env: nonSecretEnvironment(),
    timeoutMs: 120_000,
    label: "NPM",
  });
}

async function resolveCodexCommand() {
  const binRoot = path.join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin");
  try {
    const candidates = [];
    for (const entry of await readdir(binRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(binRoot, entry.name, "codex.exe");
      try {
        const metadata = await stat(candidate);
        if (metadata.isFile()) candidates.push({ candidate, mtimeMs: metadata.mtimeMs });
      } catch {
        // Continue to the next desktop-bundled Codex binary.
      }
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const { candidate } of candidates) {
      try {
        await access(candidate, constants.X_OK);
        return { executable: candidate, prefix: [], source: "desktop-bundled" };
      } catch {
        // Continue to the next accessible binary.
      }
    }
  } catch {
    // Fall back to the globally installed JavaScript launcher below.
  }
  await access(codexScriptPath, constants.R_OK);
  return { executable: process.execPath, prefix: [codexScriptPath], source: "global-npm" };
}

async function runCodex(args, options = {}) {
  assert(codexCommand !== undefined, "CODEX_COMMAND_UNRESOLVED");
  return runProcess(codexCommand.executable, [
    ...codexCommand.prefix,
    "-c",
    'model_reasoning_effort="high"',
    ...args,
  ], {
    cwd: options.cwd ?? repositoryRoot,
    env: nonSecretEnvironment(),
    input: options.input,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
    timeoutMs: options.timeoutMs ?? 120_000,
    allowedExitCodes: options.allowedExitCodes,
    label: options.label ?? "CODEX",
  });
}

export function extractQuickTunnelUrl(output) {
  for (const match of String(output).matchAll(/https:\/\/[A-Za-z0-9-]+\.trycloudflare\.com\/?/gu)) {
    try {
      const url = new URL(match[0]);
      if (
        url.protocol === "https:" &&
        /^[a-z0-9-]+\.trycloudflare\.com$/u.test(url.hostname) &&
        url.username === "" &&
        url.password === "" &&
        url.pathname === "/" &&
        url.search === "" &&
        url.hash === ""
      ) return url;
    } catch {
      // Continue looking for the bounded Quick Tunnel URL.
    }
  }
  return undefined;
}

export function extractCodexAuthorizationUrl(output, expectedOrigin) {
  const origin = new URL(expectedOrigin).origin;
  for (const match of String(output).matchAll(/https?:\/\/[^\s\u001b\u0007"<>]+/gu)) {
    let candidate;
    try {
      candidate = new URL(match[0].replace(/[),.;]+$/u, ""));
    } catch {
      continue;
    }
    if (candidate.origin !== origin || candidate.pathname !== "/oauth/authorize") continue;
    const redirectValue = candidate.searchParams.get("redirect_uri");
    let redirect;
    try {
      redirect = redirectValue === null ? null : new URL(redirectValue);
    } catch {
      redirect = null;
    }
    const clientId = candidate.searchParams.get("client_id") ?? "";
    const state = candidate.searchParams.get("state") ?? "";
    if (
      candidate.searchParams.get("response_type") === "code" &&
      clientId.length > 0 &&
      state.length > 0 &&
      /^[A-Za-z0-9_-]{43,128}$/u.test(candidate.searchParams.get("code_challenge") ?? "") &&
      candidate.searchParams.get("code_challenge_method") === "S256" &&
      candidate.searchParams.get("resource") === `${origin}/mcp` &&
      redirect !== null &&
      redirect.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname)
    ) return candidate;
  }
  return undefined;
}

export function summarizeCodexJsonEvents(events, serverName) {
  const mcpCalls = [];
  let localExecutionCount = 0;
  for (const event of events) {
    const item = event?.item;
    if (item?.type === "command_execution" || item?.type === "file_change") localExecutionCount += 1;
    if (item?.type !== "mcp_tool_call") continue;
    const server = item.server ?? item.server_name;
    const tool = item.tool ?? item.tool_name ?? item.name;
    if (server !== serverName || typeof tool !== "string") continue;
    const phase = String(event.type).endsWith("started")
      ? "started"
      : String(event.type).endsWith("completed")
        ? "completed"
        : "observed";
    mcpCalls.push({ server, tool, phase });
  }
  return { mcpCalls, localExecutionCount };
}

function parseJsonLines(text) {
  const events = [];
  for (const line of String(text).split(/\r?\n/u)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Only complete Codex JSONL event lines are evidence inputs.
    }
  }
  return events;
}

async function choosePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string", "PORT_SELECTION_FAILED");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function requestRaw(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const body = options.body === undefined ? undefined : Buffer.from(options.body);
    const request = client.request(parsed, {
      method: options.method ?? "GET",
      family: 4,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-length": String(body.length) }),
        ...(options.headers ?? {}),
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          request.destroy(new Error("HTTP_RESPONSE_TOO_LARGE"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.setTimeout(options.timeoutMs ?? 5_000, () => request.destroy(new Error("HTTP_REQUEST_TIMEOUT")));
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function waitForJson(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus;
  let lastErrorCode;
  while (Date.now() < deadline) {
    try {
      const response = await requestRaw(url);
      lastStatus = response.status;
      if (response.status >= 200 && response.status < 300) return JSON.parse(response.body);
    } catch (error) {
      lastErrorCode = error instanceof Error && "code" in error
        ? String(error.code)
        : error instanceof Error ? error.name : "UNKNOWN";
      // The server or newly-created public hostname may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label}_HEALTH_TIMEOUT_${String(lastStatus ?? lastErrorCode ?? "NO_RESPONSE")}`);
}

async function waitForManagedJson(url, timeoutMs, label, managed) {
  return Promise.race([
    waitForJson(url, timeoutMs, label),
    managed.closed.then(({ code }) => {
      throw new Error(`${label}_PROCESS_EXIT_${String(code)}`);
    }),
  ]);
}

export function quickTunnelArguments(localUrl) {
  return [
    "tunnel",
    "--url",
    localUrl,
    "--no-autoupdate",
    "--protocol",
    "http2",
  ];
}

async function startQuickTunnel(localUrl, temporaryRoot) {
  const isolatedHome = path.join(temporaryRoot, "cloudflared-home");
  await mkdir(isolatedHome, { recursive: true });
  let outputWindow = "";
  let resolveUrl;
  let rejectUrl;
  let selectedUrl;
  let registered = false;
  const urlPromise = new Promise((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  const managed = startManagedProcess(cloudflaredPath, quickTunnelArguments(localUrl), {
    cwd: isolatedHome,
    env: nonSecretEnvironment({
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      APPDATA: isolatedHome,
      LOCALAPPDATA: isolatedHome,
    }),
    onOutput(chunk) {
      outputWindow = `${outputWindow}${chunk}`.slice(-128 * 1024);
      const url = extractQuickTunnelUrl(outputWindow);
      if (url !== undefined) selectedUrl = url;
      if (outputWindow.includes("Registered tunnel connection")) registered = true;
      if (selectedUrl !== undefined && registered) resolveUrl(selectedUrl);
    },
  });
  managed.closed.then(({ code }) => rejectUrl(new Error(`CLOUDFLARED_EXIT_${String(code)}`))).catch(rejectUrl);
  const url = await Promise.race([
    urlPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("QUICK_TUNNEL_URL_TIMEOUT")), 60_000)),
  ]);
  return { managed, url };
}

function startToolSpanServer(entry, cwd, configPath) {
  return startManagedProcess(process.execPath, [entry], {
    cwd,
    env: nonSecretEnvironment({ TOOLSPAN_CONFIG: configPath }),
  });
}

async function completeCodexAuthorization(authorizationUrl, origin, password) {
  const actualScopes = new Set((authorizationUrl.searchParams.get("scope") ?? "").split(/\s+/u).filter(Boolean));
  assert(fullScopes.every((scope) => actualScopes.has(scope)), "CODEX_OAUTH_SCOPE_MISMATCH");
  const redirectValue = authorizationUrl.searchParams.get("redirect_uri");
  assert(redirectValue !== null, "CODEX_OAUTH_REDIRECT_MISSING");
  const expectedRedirect = new URL(redirectValue);
  const form = new URLSearchParams(authorizationUrl.searchParams);
  form.set("password", password);
  const approval = await requestRaw(`${origin}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    timeoutMs: 15_000,
  });
  assert(approval.status === 302, "CODEX_OAUTH_APPROVAL_FAILED");
  const location = Array.isArray(approval.headers.location)
    ? approval.headers.location[0]
    : approval.headers.location;
  assert(typeof location === "string", "CODEX_OAUTH_CALLBACK_MISSING");
  const callback = new URL(location, origin);
  assert(
    callback.origin === expectedRedirect.origin && callback.pathname === expectedRedirect.pathname,
    "CODEX_OAUTH_CALLBACK_MISMATCH",
  );
  assert(
    callback.searchParams.get("state") === authorizationUrl.searchParams.get("state") &&
      (callback.searchParams.get("code")?.length ?? 0) > 0,
    "CODEX_OAUTH_CALLBACK_BINDING_FAILED",
  );
  const completed = await requestRaw(callback, { timeoutMs: 15_000 });
  assert(completed.status >= 200 && completed.status < 300, "CODEX_OAUTH_CALLBACK_FAILED");
}

async function runCodexOAuthCommand(args, origin, password, options = {}) {
  let outputWindow = "";
  let authorizationTask;
  const inspect = (chunk) => {
    if (authorizationTask !== undefined) return authorizationTask;
    outputWindow = `${outputWindow}${chunk}`.slice(-128 * 1024);
    const authorizationUrl = extractCodexAuthorizationUrl(outputWindow, origin);
    if (authorizationUrl === undefined) return undefined;
    outputWindow = "";
    authorizationTask = completeCodexAuthorization(authorizationUrl, origin, password);
    return authorizationTask;
  };
  const result = await runCodex(args, {
    onStdout: inspect,
    onStderr: inspect,
    timeoutMs: 120_000,
    label: options.label ?? "CODEX_MCP_OAUTH",
  });
  if (options.requireAuthorization === true) assert(authorizationTask !== undefined, "CODEX_OAUTH_URL_MISSING");
  if (authorizationTask !== undefined) await authorizationTask;
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(!combined.includes(password), "CODEX_LOGIN_LOGGED_PASSWORD");
  assert(!/Bearer\s+[A-Za-z0-9._~+/-]{12,}=*/u.test(combined), "CODEX_LOGIN_LOGGED_BEARER");
  return authorizationTask !== undefined;
}

async function loginCodexMcpWithRetries(serverName, origin, password) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await runCodexOAuthCommand([
        "mcp",
        "login",
        serverName,
        "--scopes",
        fullScopes.join(","),
      ], origin, password, { label: "CODEX_MCP_LOGIN", requireAuthorization: true });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : "";
      if (!/^CODEX_MCP_LOGIN_(?:EXIT_1|TIMEOUT)$/u.test(message) || attempt === 5) throw error;
      await runCodex(["mcp", "logout", serverName], {
        allowedExitCodes: [0, 1],
        label: "CODEX_MCP_LOGIN_RETRY_LOGOUT",
      });
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
  throw lastError ?? new Error("CODEX_MCP_LOGIN_RETRIES_EXHAUSTED");
}

function assertTemporaryRoot(directory) {
  const base = path.resolve(tmpdir());
  const resolved = path.resolve(directory);
  const relative = path.relative(base, resolved);
  assert(
    relative.startsWith("toolspan-codex-remote-") &&
      !relative.includes(path.sep) &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative),
    "UNOWNED_TEMPORARY_ROOT",
  );
}

function assertSafeEvidence(evidence, secrets) {
  const serialized = JSON.stringify(evidence);
  for (const secret of secrets) assert(!serialized.includes(secret), "EVIDENCE_CONTAINS_SECRET");
  assert(!/[A-Za-z]:\\[^"\n]+/u.test(serialized), "EVIDENCE_CONTAINS_WINDOWS_PATH");
  assert(!/Bearer\s+[A-Za-z0-9._~+/-]{12,}=*/u.test(serialized), "EVIDENCE_CONTAINS_BEARER");
}

async function writeEvidence(fileName, evidence, secrets) {
  assertSafeEvidence(evidence, secrets);
  const directory = path.join(repositoryRoot, ".toolspan-dev", "evidence");
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, fileName);
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
  assertSafeEvidence(JSON.parse(await readFile(destination, "utf8")), secrets);
  return path.posix.join(".toolspan-dev", "evidence", fileName);
}

async function writeExternalEvidence(observedAt, proof, secrets) {
  const evidence = {
    schemaVersion: "1.0",
    requirementId: "E-CODEX-01",
    status: "PASS",
    observedAt,
    sanitized: true,
    secretValues: 0,
    proof,
  };
  assertSafeEvidence(evidence, secrets);
  const directory = path.join(repositoryRoot, ".toolspan-dev", "evidence", "external");
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, "E-CODEX-01.json");
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
  assertSafeEvidence(JSON.parse(await readFile(destination, "utf8")), secrets);
  return path.posix.join(".toolspan-dev", "evidence", "external", "E-CODEX-01.json");
}

async function run() {
  assert(process.argv.length === 2, "COMMAND_LINE_ARGUMENTS_FORBIDDEN");
  await access(cloudflaredPath, constants.X_OK);
  codexCommand = await resolveCodexCommand();
  assert(sha256(await readFile(cloudflaredPath)) === cloudflaredSha256, "CLOUDFLARED_HASH_MISMATCH");
  const sourceFixture = await realpath(fixtureRoot);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "toolspan-codex-remote-"));
  assertTemporaryRoot(temporaryRoot);
  const sessionId = new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14) + randomBytes(5).toString("hex");
  const serverName = `toolspan_e2e_${sessionId.slice(-10)}`;
  const instanceName = `toolspan-codex-e2e-${sessionId.slice(-10)}`;
  const remoteWorkspace = path.join(temporaryRoot, "remote-workspace");
  const remoteWritable = path.join(remoteWorkspace, "writable.txt");
  const localWritable = path.join(sourceFixture, "writable.txt");
  const codexWorkdir = path.join(temporaryRoot, "codex-workdir");
  const secrets = [];
  let quickTunnel;
  let toolSpanServer;
  let codexServerAdded = false;
  let codexLoggedIn = false;
  let result;
  let runError;
  const cleanupErrors = [];

  try {
    await cp(sourceFixture, remoteWorkspace, { recursive: true, errorOnExist: true });
    await mkdir(codexWorkdir);
    const localBeforeSha256 = sha256(await readFile(localWritable));
    const remoteOriginal = await readFile(remoteWritable, "utf8");
    const remoteBeforeSha256 = sha256(remoteOriginal);
    await runNpm(["run", "build"], repositoryRoot);

    const password = `${randomBytes(36).toString("base64url")}!a9`;
    secrets.push(password);
    const passwordHashFile = path.join(temporaryRoot, "owner.bcrypt");
    const passwordInit = await runProcess(process.execPath, [
      path.join(repositoryRoot, "dist", "cli", "init-password.js"),
      "--file",
      passwordHashFile,
    ], {
      cwd: repositoryRoot,
      env: nonSecretEnvironment(),
      input: `${password}\n`,
      timeoutMs: 30_000,
      label: "PASSWORD_INIT",
    });
    assert(!`${passwordInit.stdout}\n${passwordInit.stderr}`.includes(password), "PASSWORD_INIT_LOGGED_SECRET");

    const port = await choosePort();
    const localOrigin = `http://127.0.0.1:${port}`;
    quickTunnel = await startQuickTunnel(localOrigin, temporaryRoot);
    const publicOrigin = quickTunnel.url.origin;
    const configuredBefore = JSON.parse((await runCodex(["mcp", "list", "--json"])).stdout);
    assert(!configuredBefore.some((entry) => entry.name === serverName), "CODEX_SERVER_NAME_COLLISION");
    codexServerAdded = true;
    await runCodex(["mcp", "add", serverName, "--url", `${publicOrigin}/mcp`], {
      label: "CODEX_MCP_ADD",
      timeoutMs: 30_000,
    });
    const configPath = path.join(temporaryRoot, "toolspan.synthetic.json");
    await writeFile(configPath, `${JSON.stringify({
      instanceName,
      host: "127.0.0.1",
      port,
      publicBaseUrl: publicOrigin,
      allowedRoots: [remoteWorkspace],
      stateDirectory: path.join(temporaryRoot, "state"),
      ownerPasswordHashFile: passwordHashFile,
    }, null, 2)}\n`, "utf8");
    toolSpanServer = startToolSpanServer(path.join(repositoryRoot, "dist", "main.js"), remoteWorkspace, configPath);
    await waitForManagedJson(`${localOrigin}/healthz`, 30_000, "LOCAL_TOOLSPAN", toolSpanServer);

    codexLoggedIn = await loginCodexMcpWithRetries(serverName, publicOrigin, password);

    const configuredAfter = JSON.parse((await runCodex(["mcp", "list", "--json"])).stdout);
    const configuredServer = configuredAfter.find((entry) => entry.name === serverName);
    assert(configuredServer?.enabled === true, "CODEX_MCP_NOT_ENABLED");

    const marker = `toolspan-codex-remote-proof-${sessionId}`;
    const outputSchemaPath = path.join(temporaryRoot, "codex-output.schema.json");
    const outputPath = path.join(temporaryRoot, "codex-output.json");
    await writeFile(outputSchemaPath, `${JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["instanceName", "toolCount", "readPassed", "writePassed", "jobPassed", "marker"],
      properties: {
        instanceName: { type: "string" },
        toolCount: { type: "integer" },
        readPassed: { type: "boolean" },
        writePassed: { type: "boolean" },
        jobPassed: { type: "boolean" },
        marker: { type: "string" },
      },
    }, null, 2)}\n`, "utf8");
    const prompt = [
      "Perform the authorized E-CODEX-01 validation using only MCP tools from the ToolSpan server configured for this run.",
      "Do not use shell, command execution, local filesystem tools, web tools, or built-in apply_patch.",
      `The expected ToolSpan instanceName is ${instanceName}. Count the ToolSpan MCP tools visible to you; it must be exactly ${EXPECTED_TOOLS.length}.`,
      "Call devspace_info and confirm the instance. Call open_workspace with path '.'.",
      "Read writable.txt, then call the ToolSpan MCP apply_patch tool with dryRun=true to append the marker below; verify dry-run did not apply it.",
      "Call the same ToolSpan MCP apply_patch with dryRun=false, then read writable.txt and confirm the marker.",
      "Start the allowlisted npm job with args ['run','toolspan:e2e'], poll until completed, and read output/job-result.txt to confirm completion.",
      `Marker: ${marker}`,
      "Return only the JSON object required by the supplied schema, with all three pass booleans true only after direct observation.",
    ].join("\n");
    assert(!secrets.some((secret) => prompt.includes(secret)), "CODEX_PROMPT_CONTAINS_SECRET");
    const execResult = await runCodex([
      "-c",
      `mcp_servers.${serverName}.url=\"${publicOrigin}/mcp\"`,
      "-c",
      `mcp_servers.${serverName}.auth=\"oauth\"`,
      "-c",
      `mcp_servers.${serverName}.scopes=[\"workspace:read\",\"workspace:write\",\"jobs:run\",\"artifacts:publish\"]`,
      "-c",
      `mcp_servers.${serverName}.required=true`,
      "-c",
      `mcp_servers.${serverName}.tool_timeout_sec=90`,
      "-c",
      `mcp_servers.${serverName}.default_tools_approval_mode=\"approve\"`,
      "-c",
      'approval_policy="never"',
      "exec",
      "--ignore-user-config",
      "--json",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--cd",
      codexWorkdir,
      "--output-schema",
      outputSchemaPath,
      "--output-last-message",
      outputPath,
      "-",
    ], {
      cwd: codexWorkdir,
      input: prompt,
      timeoutMs: 600_000,
      label: "CODEX_REMOTE_EXEC",
    });
    const execCombined = `${execResult.stdout}\n${execResult.stderr}`;
    assert(!secrets.some((secret) => execCombined.includes(secret)), "CODEX_EXEC_LOGGED_SECRET");
    assert(!/Bearer\s+[A-Za-z0-9._~+/-]{12,}=*/u.test(execCombined), "CODEX_EXEC_LOGGED_BEARER");
    const events = parseJsonLines(execResult.stdout);
    const eventSummary = summarizeCodexJsonEvents(events, serverName);
    assert(eventSummary.localExecutionCount === 0, "CODEX_USED_LOCAL_EXECUTION");
    const completedTools = new Set(eventSummary.mcpCalls.filter((call) => call.phase === "completed").map((call) => call.tool));
    for (const required of ["devspace_info", "open_workspace", "read", "apply_patch", "start_job", "poll_job"]) {
      assert(completedTools.has(required), `CODEX_MCP_CALL_MISSING_${required.toUpperCase()}`);
    }

    const final = JSON.parse(await readFile(outputPath, "utf8"));
    assert(final.instanceName === instanceName, "CODEX_INSTANCE_MISMATCH");
    assert(final.toolCount === EXPECTED_TOOLS.length, "CODEX_TOOL_COUNT_MISMATCH");
    assert(final.readPassed === true && final.writePassed === true && final.jobPassed === true, "CODEX_REMOTE_SEQUENCE_INCOMPLETE");
    assert(final.marker === marker, "CODEX_MARKER_MISMATCH");
    const remoteAfterSha256 = sha256(await readFile(remoteWritable));
    const localAfterSha256 = sha256(await readFile(localWritable));
    assert(remoteAfterSha256 !== remoteBeforeSha256, "REMOTE_WORKSPACE_UNCHANGED");
    assert(localAfterSha256 === localBeforeSha256, "LOCAL_FIXTURE_CHANGED");
    const jobOutput = await readFile(path.join(remoteWorkspace, "output", "job-result.txt"), "utf8");
    assert(jobOutput.includes("toolspan-release-e2e-job: completed"), "REMOTE_JOB_OUTPUT_MISSING");
    result = {
      generatedAt: new Date().toISOString(),
      sessionId,
      serverName,
      publicMcpUrl: `${publicOrigin}/mcp`,
      codexCliVersion: (await runCodex(["--version"])).stdout.trim(),
      toolCalls: eventSummary.mcpCalls,
      proof: {
        kind: "CODEX_REMOTE_E2E",
        remoteInstanceUrl: `${publicOrigin}/mcp`,
        devspaceInfoConfirmed: true,
        toolCount: EXPECTED_TOOLS.length,
        readPassed: true,
        writePassed: true,
        jobPassed: true,
        remoteBeforeSha256,
        remoteAfterSha256,
        localBeforeSha256,
        localAfterSha256,
      },
    };
  } catch (error) {
    runError = error;
  } finally {
    if (codexServerAdded) {
      try {
        const current = JSON.parse((await runCodex(["mcp", "list", "--json"])).stdout);
        if (current.some((entry) => entry.name === serverName)) {
          await runCodex(["mcp", "logout", serverName], { allowedExitCodes: [0, 1], label: "CODEX_MCP_LOGOUT" });
          codexLoggedIn = false;
          await runCodex(["mcp", "remove", serverName], { allowedExitCodes: [0, 1], label: "CODEX_MCP_REMOVE" });
        }
        codexServerAdded = false;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await stopManagedProcess(toolSpanServer);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await stopManagedProcess(quickTunnel?.managed);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      assertTemporaryRoot(temporaryRoot);
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await rm(cloudflaredPath, { force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (runError !== undefined) throw runError;
  assert(cleanupErrors.length === 0, "E_CODEX_CLEANUP_FAILED");
  assert(result !== undefined, "E_CODEX_RESULT_MISSING");
  const configuredFinal = JSON.parse((await runCodex(["mcp", "list", "--json"])).stdout);
  assert(!configuredFinal.some((entry) => entry.name === serverName), "CODEX_MCP_CONFIG_NOT_REMOVED");
  assert(!codexLoggedIn && !codexServerAdded, "CODEX_AUTH_OR_CONFIG_REMAINS");
  try {
    await access(temporaryRoot);
    throw new Error("SYNTHETIC_WORKSPACE_NOT_REMOVED");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const detailedEvidence = {
    schemaVersion: "1.0",
    evidenceType: "CODEX_REAL_REMOTE_MCP_E2E",
    generatedAt: result.generatedAt,
    sanitized: true,
    secretValues: 0,
    codexCliVersion: result.codexCliVersion,
    remoteInstanceUrl: result.publicMcpUrl,
    transport: "streamable-http-json",
    oauth: "AUTHORIZATION_CODE_PKCE_DCR",
    exactToolCount: EXPECTED_TOOLS.length,
    toolCalls: result.toolCalls,
    cleanup: {
      codexOauthLoggedOut: true,
      codexMcpConfigRemoved: true,
      quickTunnelStopped: true,
      syntheticToolSpanStopped: true,
      syntheticWorkspaceRemoved: true,
      cloudflaredBinaryRemoved: true,
    },
    proof: result.proof,
  };
  const evidencePath = await writeEvidence(`codex-remote-e2e-${result.sessionId}.json`, detailedEvidence, secrets);
  const externalEvidencePath = await writeExternalEvidence(result.generatedAt, result.proof, secrets);
  return {
    status: "PASS",
    requirementId: "E-CODEX-01",
    evidence: evidencePath,
    externalEvidence: externalEvidencePath,
    toolCount: EXPECTED_TOOLS.length,
    cleanup: "PASS",
  };
}

export function publicCodexE2eError(error) {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{2,99}$/u.test(message) ? message : "CODEX_REMOTE_E2E_FAILED";
}

async function main() {
  const summary = await run();
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${publicCodexE2eError(error)}\n`);
    process.exitCode = 1;
  });
}
