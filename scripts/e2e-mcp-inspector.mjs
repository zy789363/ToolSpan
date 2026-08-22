import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { compare } from "bcryptjs";

export const FIXTURE_RELATIVE_PATH = "tests/e2e-fixtures/remote-workspace";
export const EXPECTED_TOOLS = [
  "apply_patch",
  "cancel_job",
  "copy_path",
  "delete_path",
  "devspace_info",
  "edit",
  "import_asset",
  "inspect_artifact",
  "list_artifacts",
  "list_directory",
  "list_jobs",
  "list_workspaces",
  "make_directory",
  "move_path",
  "open_workspace",
  "poll_job",
  "preview_artifact",
  "publish_artifact",
  "read",
  "read_many",
  "restore_path",
  "resume_workspace",
  "search_files",
  "start_capture",
  "start_job",
  "stat_path",
  "write",
].sort();

const SDK_VERSION = "1.30.0";
const INSTANCE_NAME = "toolspan-release-e2e";
const PROTOCOL_VERSION = "2025-11-25";
const FINAL_JOB_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const HOST_LOG_CREDENTIAL_PATTERNS = [
  /Bearer\s+(?!(?:resource_metadata|error)(?=[\s=,]|$))[A-Za-z0-9._~+/-]{8,}=*/iu,
  /(?:authorization|cookie|x-auth-key|password|passphrase|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|api[_ -]?key)\s*[:=]\s*(?!<redacted>|redacted|masked)[^\s"'&]{8,}/iu,
];

export function createHostLogSecretScanner() {
  const chunks = { stdout: [], stderr: [] };
  return {
    write(stream, chunk) {
      assert(stream === "stdout" || stream === "stderr", "HOST_LOG_STREAM_INVALID");
      chunks[stream].push(String(chunk));
    },
    finish(sensitiveValues = []) {
      const findings = [];
      const secrets = [...new Set(sensitiveValues.filter((value) => typeof value === "string" && value.length > 0))];
      for (const stream of ["stdout", "stderr"]) {
        const text = chunks[stream].join("");
        if (secrets.some((secret) => text.includes(secret))) {
          findings.push({ stream, code: "KNOWN_TRANSIENT_VALUE" });
        }
        if (HOST_LOG_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) {
          findings.push({ stream, code: "CREDENTIAL_PATTERN" });
        }
      }
      return { status: findings.length === 0 ? "PASS" : "FAIL", findings };
    },
  };
}

export function completeHostLogSecretSafety(evidence, scanner, sensitiveValues) {
  const result = scanner.finish(sensitiveValues);
  if (result.status !== "PASS") throw new Error("HOST_LOG_SECRET_SCAN_FAILED");
  evidence.secretSafety.secretValuesLogged = false;
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isMissing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function nonSecretEnvironment(extra = {}) {
  const allowedNames = new Set([
    "APPDATA",
    "CI",
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

export function extractInspectorAuthorizationUrl(output, expectedOrigin) {
  const origin = new URL(expectedOrigin).origin;
  const matches = String(output).matchAll(/https?:\/\/[^\s\u001b\u0007"<>]+/gu);
  for (const match of matches) {
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
    const redirectIsLoopback = redirect !== null && redirect.protocol === "http:" &&
      ["127.0.0.1", "[::1]", "localhost"].includes(redirect.hostname) &&
      redirect.pathname === "/oauth/callback";
    if (
      candidate.searchParams.get("response_type") !== "code" ||
      candidate.searchParams.get("client_id")?.length === 0 ||
      candidate.searchParams.get("state")?.length === 0 ||
      !/^[A-Za-z0-9_-]{43,128}$/u.test(candidate.searchParams.get("code_challenge") ?? "") ||
      candidate.searchParams.get("code_challenge_method") !== "S256" ||
      candidate.searchParams.get("resource") !== `${origin}/mcp` ||
      !redirectIsLoopback
    ) continue;
    return candidate;
  }
  return undefined;
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
      // Try the next exact JavaScript npm entry point without invoking a command shell.
    }
  }
  throw new Error("npm JavaScript entry point is unavailable; run this harness through npm");
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
    const callback = (handler, chunk) => {
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
      if (stdout.length < 256 * 1024) stdout += chunk;
      callback(options.onStdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 256 * 1024) stderr += chunk;
      callback(options.onStderr, chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      if (callbackError !== undefined) {
        reject(callbackError);
        return;
      }
      if (timedOut) {
        reject(new Error("CHILD_PROCESS_TIMEOUT"));
        return;
      }
      const allowedExitCodes = options.allowedExitCodes ?? [0];
      if (allowedExitCodes.includes(code)) {
        resolve({ stdout, stderr, code, signal });
        return;
      }
      reject(new Error(`Child process ${options.label ?? "unlabeled"} failed with exit code ${String(code)}${signal === null ? "" : ` (${signal})`}`));
    });
    child.stdin.end(options.input);
  });
}

async function runNpm(args, cwd, options = {}) {
  return runProcess(process.execPath, [await npmCliPath(), ...args], {
    cwd,
    env: options.env ?? nonSecretEnvironment(),
    allowedExitCodes: options.allowedExitCodes,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
    timeoutMs: options.timeoutMs,
    label: options.label,
  });
}

async function runOfficialInspectorAuthSmoke(origin, temporaryRoot) {
  const inspectorStorage = path.join(temporaryRoot, "inspector-storage");
  const oauthStatePath = path.join(inspectorStorage, "oauth.json");
  const clientConfigPath = path.join(inspectorStorage, "client.json");
  await mkdir(inspectorStorage);
  const versionResult = await runNpm([
    "view",
    "@modelcontextprotocol/inspector@latest",
    "version",
    "--json",
  ], repositoryRoot);
  const resolvedVersion = JSON.parse(versionResult.stdout.trim());
  assert(
    typeof resolvedVersion === "string" && /^2\.[0-9]+\.[0-9]+$/u.test(resolvedVersion),
    "Official Inspector latest did not resolve to a v2 release",
  );

  const cliArguments = [
    "exec",
    "--yes",
    "--package=@modelcontextprotocol/inspector@latest",
    "--",
    "mcp-inspector",
    "--cli",
    `${origin}/mcp`,
    "--transport",
    "http",
    "--method",
    "tools/list",
    "--format",
    "json",
    "--stored-auth-only",
  ];
  assert(
    !cliArguments.some((argument) =>
      argument === "--header" ||
      argument === "--client-secret" ||
      argument === "--use-stored-auth" ||
      /^Authorization:/iu.test(argument)),
    "Inspector auth smoke attempted to pass a credential",
  );
  const result = await runNpm(cliArguments, repositoryRoot, {
    env: nonSecretEnvironment({
      MCP_CLIENT_CONFIG_PATH: clientConfigPath,
      MCP_INSPECTOR_OAUTH_STATE_PATH: oauthStatePath,
      MCP_STORAGE_DIR: inspectorStorage,
    }),
    allowedExitCodes: [3],
  });
  let output;
  for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/u).reverse()) {
    if (!line.trim().startsWith("{")) continue;
    try {
      output = JSON.parse(line.trim());
      break;
    } catch {
      // npm may add non-JSON diagnostics around the Inspector JSON line.
    }
  }
  assert(output !== undefined, "Official Inspector auth smoke did not emit a JSON line");
  assert(output?.error?.code === "auth_required", "Official Inspector did not report auth_required");
  const storageEntries = await readdir(inspectorStorage);
  assert(storageEntries.length === 0, "Inspector auth smoke wrote an auth or client store");
  assert(!result.stdout.includes("Bearer ") && !result.stderr.includes("Bearer "), "Inspector auth smoke logged a bearer credential");
  return { resolvedVersion, exitCode: result.code };
}

function inspectorNpmArguments(version) {
  return [
    "exec",
    "--yes",
    `--package=@modelcontextprotocol/inspector@${version}`,
    "--",
    "mcp-inspector",
    "--cli",
  ];
}

function assertCredentialFreeInspectorArguments(args, sensitiveValues = []) {
  assert(!args.some((argument) =>
    argument === "--header" ||
    argument === "--client-secret" ||
    argument === "--use-stored-auth" ||
    /^Authorization:/iu.test(argument)), "Inspector arguments contain a credential surface");
  const serialized = JSON.stringify(args);
  for (const value of sensitiveValues) {
    assert(!serialized.includes(value), "Inspector arguments contain a transient Secret");
  }
}

function parseInspectorEnvelope(result) {
  for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/u).reverse()) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line.trim());
      if (typeof parsed === "object" && parsed !== null) return parsed;
    } catch {
      // npm and Inspector may add non-JSON diagnostics around the one-line JSON result.
    }
  }
  throw new Error("INSPECTOR_JSON_RESULT_MISSING");
}

async function completeInspectorLoopbackAuthorization(authorizationUrl, origin, password, expectedScopes) {
  const actualScopes = new Set((authorizationUrl.searchParams.get("scope") ?? "").split(/\s+/u).filter(Boolean));
  assert(expectedScopes.every((scope) => actualScopes.has(scope)), "INSPECTOR_OAUTH_SCOPE_MISMATCH");
  const redirectValue = authorizationUrl.searchParams.get("redirect_uri");
  assert(redirectValue !== null, "INSPECTOR_OAUTH_REDIRECT_MISSING");
  const expectedRedirect = new URL(redirectValue);
  const form = new URLSearchParams(authorizationUrl.searchParams);
  form.set("password", password);
  const approval = await fetch(`${origin}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    redirect: "manual",
  });
  assert(approval.status === 302, "INSPECTOR_OAUTH_APPROVAL_FAILED");
  const location = approval.headers.get("location");
  assert(location !== null, "INSPECTOR_OAUTH_CALLBACK_MISSING");
  const callback = new URL(location, origin);
  assert(
    callback.origin === expectedRedirect.origin && callback.pathname === expectedRedirect.pathname,
    "INSPECTOR_OAUTH_CALLBACK_MISMATCH",
  );
  assert(
    callback.searchParams.get("state") === authorizationUrl.searchParams.get("state") &&
      (callback.searchParams.get("code")?.length ?? 0) > 0,
    "INSPECTOR_OAUTH_CALLBACK_BINDING_FAILED",
  );
  const completed = await fetch(callback, { redirect: "manual" });
  assert(completed.status >= 200 && completed.status < 300, "INSPECTOR_OAUTH_CALLBACK_FAILED");
}

async function createOfficialInspectorSession({
  origin,
  temporaryRoot,
  password,
  resolvedVersion,
  name,
  scopes,
}) {
  const storageDirectory = path.join(temporaryRoot, name);
  const oauthStatePath = path.join(storageDirectory, "oauth.json");
  const clientConfigPath = path.join(storageDirectory, "client.json");
  const serverConfigPath = path.join(storageDirectory, "servers.json");
  await mkdir(storageDirectory);
  const config = JSON.stringify({
    mcpServers: {
      toolspan: {
        type: "http",
        url: `${origin}/mcp`,
        oauth: { scopes: scopes.join(" ") },
      },
    },
  }, null, 2);
  assert(!config.includes(password), "Inspector server config contains a transient Secret");
  await writeFile(serverConfigPath, `${config}\n`, "utf8");
  const callbackPort = await choosePort();
  const callbackUrl = `http://127.0.0.1:${callbackPort}/oauth/callback`;
  const scanner = createHostLogSecretScanner();
  let stderrWindow = "";
  let authorizationTask;
  const args = [
    ...inspectorNpmArguments(resolvedVersion),
    "--config",
    serverConfigPath,
    "--server",
    "toolspan",
    "--method",
    "tools/list",
    "--format",
    "json",
  ];
  assertCredentialFreeInspectorArguments(args, [password]);
  const result = await runNpm(args, repositoryRoot, {
    env: nonSecretEnvironment({
      MCP_AUTO_OPEN_ENABLED: "true",
      MCP_CLIENT_CONFIG_PATH: clientConfigPath,
      MCP_INSPECTOR_OAUTH_STATE_PATH: oauthStatePath,
      MCP_OAUTH_CALLBACK_URL: callbackUrl,
      MCP_STORAGE_DIR: storageDirectory,
    }),
    onStdout(chunk) {
      scanner.write("stdout", chunk);
    },
    onStderr(chunk) {
      scanner.write("stderr", chunk);
      if (authorizationTask !== undefined) return authorizationTask;
      stderrWindow = `${stderrWindow}${chunk}`.slice(-128 * 1024);
      const authorizationUrl = extractInspectorAuthorizationUrl(stderrWindow, origin);
      if (authorizationUrl === undefined) return undefined;
      stderrWindow = "";
      authorizationTask = completeInspectorLoopbackAuthorization(
        authorizationUrl,
        origin,
        password,
        scopes,
      );
      return authorizationTask;
    },
    timeoutMs: 60_000,
    label: `inspector-initial-${name}`,
  });
  assert(authorizationTask !== undefined, "INSPECTOR_OAUTH_URL_MISSING");
  await authorizationTask;
  const oauthState = await stat(oauthStatePath);
  assert(oauthState.isFile() && oauthState.size > 0 && oauthState.size < 1024 * 1024, "INSPECTOR_OAUTH_STATE_INVALID");
  const initialEnvelope = parseInspectorEnvelope(result);
  assert(initialEnvelope.error === undefined, "INSPECTOR_AUTHENTICATED_LIST_FAILED");
  return {
    storageDirectory,
    oauthStatePath,
    clientConfigPath,
    resolvedVersion,
    origin,
    scanner,
    initialEnvelope,
  };
}

async function runOfficialInspectorInvocation(
  session,
  { method, toolName, toolArguments, label, allowedExitCodes, expectedErrorCode },
  sensitiveValues,
) {
  const args = [
    ...inspectorNpmArguments(session.resolvedVersion),
    "--server-url",
    `${session.origin}/mcp`,
    "--transport",
    "http",
    "--stored-auth-only",
    "--method",
    method,
    "--format",
    "json",
  ];
  if (toolName !== undefined) args.push("--tool-name", toolName);
  if (toolArguments !== undefined) args.push("--tool-args-json", JSON.stringify(toolArguments));
  assertCredentialFreeInspectorArguments(args, sensitiveValues);
  const result = await runNpm(args, repositoryRoot, {
    env: nonSecretEnvironment({
      MCP_AUTO_OPEN_ENABLED: "false",
      MCP_CLIENT_CONFIG_PATH: session.clientConfigPath,
      MCP_INSPECTOR_OAUTH_STATE_PATH: session.oauthStatePath,
      MCP_STORAGE_DIR: session.storageDirectory,
    }),
    onStdout(chunk) {
      session.scanner.write("stdout", chunk);
    },
    onStderr(chunk) {
      session.scanner.write("stderr", chunk);
    },
    allowedExitCodes: allowedExitCodes ?? [0],
    timeoutMs: 60_000,
    label: `inspector-${label ?? `${method}-${toolName ?? "none"}`}`,
  });
  const envelope = parseInspectorEnvelope(result);
  if (expectedErrorCode !== undefined) {
    assert(envelope.error?.code === expectedErrorCode, "INSPECTOR_EXPECTED_ERROR_MISSING");
    return { inspectorError: envelope.error };
  }
  assert(envelope.error === undefined, "INSPECTOR_AUTHENTICATED_CALL_FAILED");
  return envelope.result;
}

async function runOfficialInspectorAuthorizedSequence({
  origin,
  temporaryRoot,
  password,
  resolvedVersion,
  fixtureRoot,
  originalWritable,
  originalWritableHash,
  writablePath,
}) {
  const fullScopes = ["workspace:read", "workspace:write", "jobs:run", "artifacts:publish"];
  const fullSession = await createOfficialInspectorSession({
    origin,
    temporaryRoot,
    password,
    resolvedVersion,
    name: "inspector-authorized-full",
    scopes: fullScopes,
  });
  const tools = fullSession.initialEnvelope.result?.tools;
  assert(Array.isArray(tools), "INSPECTOR_TOOLS_LIST_INVALID");
  const toolNames = tools.map((tool) => tool.name).sort();
  assert(JSON.stringify(toolNames) === JSON.stringify(EXPECTED_TOOLS), "INSPECTOR_TOOL_CONTRACT_MISMATCH");

  const devspace = structured(
    await runOfficialInspectorInvocation(fullSession, {
      method: "tools/call",
      toolName: "devspace_info",
      toolArguments: {},
    }, [password]),
    "Inspector devspace_info",
  );
  assert(devspace.instanceName === INSTANCE_NAME, "INSPECTOR_INSTANCE_MISMATCH");
  const opened = structured(
    await runOfficialInspectorInvocation(fullSession, {
      method: "tools/call",
      toolName: "open_workspace",
      toolArguments: { path: fixtureRoot },
      label: "fixture-root",
    }, [password]),
    "Inspector open_workspace",
  );
  const workspaceId = opened.id;
  assert(typeof workspaceId === "string", "INSPECTOR_WORKSPACE_ID_MISSING");
  const readme = structured(
    await runOfficialInspectorInvocation(fullSession, {
      method: "tools/call",
      toolName: "read",
      toolArguments: { workspaceId, path: "README.txt" },
    }, [password]),
    "Inspector read README.txt",
  );
  assert(
    Array.isArray(readme.lines) && readme.lines.join("\n").includes("only allowed workspace root"),
    "INSPECTOR_READ_FAILED",
  );

  const mutationProof = "toolspan-release-e2e-protocol-proof: applied\n";
  const mutatedWritable = `${originalWritable}${mutationProof}`;
  const patchArguments = {
    workspaceId,
    operations: [{
      op: "edit_file",
      path: "writable.txt",
      oldText: originalWritable,
      newText: mutatedWritable,
    }],
  };
  const dryRun = structured(
    await runOfficialInspectorInvocation(fullSession, {
      method: "tools/call",
      toolName: "apply_patch",
      toolArguments: { ...patchArguments, dryRun: true },
      label: "full-apply-patch-dry-run",
    }, [password]),
    "Inspector apply_patch dry run",
  );
  assert(dryRun.dryRun === true && dryRun.applied === false, "INSPECTOR_DRY_RUN_INVALID");
  assert(sha256(await readFile(writablePath, "utf8")) === originalWritableHash, "INSPECTOR_DRY_RUN_MUTATED");
  const applied = structured(
    await runOfficialInspectorInvocation(fullSession, {
      method: "tools/call",
      toolName: "apply_patch",
      toolArguments: { ...patchArguments, dryRun: false },
      label: "full-apply-patch",
    }, [password]),
    "Inspector apply_patch",
  );
  assert(applied.applied === true, "INSPECTOR_MUTATION_FAILED");
  const writableAfterHash = sha256(await readFile(writablePath, "utf8"));
  assert(writableAfterHash !== originalWritableHash, "INSPECTOR_MUTATION_NOT_OBSERVED");
  const readback = structured(
    await runOfficialInspectorInvocation(fullSession, {
      method: "tools/call",
      toolName: "read",
      toolArguments: { workspaceId, path: "writable.txt" },
    }, [password]),
    "Inspector read writable.txt",
  );
  assert(
    Array.isArray(readback.lines) && readback.lines.join("\n").includes(mutationProof.trim()),
    "INSPECTOR_MUTATION_READBACK_FAILED",
  );

  const started = structured(
    await runOfficialInspectorInvocation(fullSession, {
      method: "tools/call",
      toolName: "start_job",
      toolArguments: { workspaceId, runner: "npm", args: ["run", "toolspan:e2e"] },
    }, [password]),
    "Inspector start_job",
  );
  assert(typeof started.id === "string", "INSPECTOR_JOB_ID_MISSING");
  let polled;
  const pollDeadline = Date.now() + 60_000;
  do {
    polled = structured(
      await runOfficialInspectorInvocation(fullSession, {
        method: "tools/call",
        toolName: "poll_job",
        toolArguments: { jobId: started.id },
      }, [password]),
      "Inspector poll_job",
    );
    if (FINAL_JOB_STATUSES.has(polled.job?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < pollDeadline);
  assert(polled.job?.status === "completed", "INSPECTOR_JOB_FAILED");
  const jobOutput = structured(
    await runOfficialInspectorInvocation(fullSession, {
      method: "tools/call",
      toolName: "read",
      toolArguments: { workspaceId, path: "output/job-result.txt" },
    }, [password]),
    "Inspector read job output",
  );
  assert(
    Array.isArray(jobOutput.lines) && jobOutput.lines.join("\n").includes("toolspan-release-e2e-job: completed"),
    "INSPECTOR_JOB_OUTPUT_INVALID",
  );

  const readOnlySession = await createOfficialInspectorSession({
    origin,
    temporaryRoot,
    password,
    resolvedVersion,
    name: "inspector-authorized-read-only",
    scopes: ["workspace:read"],
  });
  const insufficient = await runOfficialInspectorInvocation(readOnlySession, {
    method: "tools/call",
    toolName: "apply_patch",
    toolArguments: {
      workspaceId,
      operations: [{
        op: "edit_file",
        path: "writable.txt",
        oldText: mutatedWritable,
        newText: originalWritable,
      }],
      dryRun: false,
    },
    label: "read-only-apply-patch",
    allowedExitCodes: [0, 5, 3221226505],
    expectedErrorCode: "tool_is_error",
  }, [password]);
  assert(
    insufficient.inspectorError?.code === "tool_is_error",
    "INSPECTOR_READ_ONLY_WRITE_REJECTION_MISSING",
  );
  assert(sha256(await readFile(writablePath, "utf8")) === writableAfterHash, "INSPECTOR_READ_ONLY_MUTATED");

  for (const session of [fullSession, readOnlySession]) {
    const scan = session.scanner.finish([password]);
    assert(scan.status === "PASS", "INSPECTOR_LOG_SECRET_SCAN_FAILED");
  }
  return {
    toolCount: toolNames.length,
    initializePassed: true,
    readPassed: true,
    mutationPassed: true,
    jobPassed: true,
    insufficientScopePassed: true,
    authStoresCreated: 2,
    writableAfterHash,
  };
}

async function choosePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string", "Could not allocate a loopback port");
  await new Promise((resolve, reject) => server.close((error) => {
    if (error === undefined) resolve();
    else reject(error);
  }));
  return address.port;
}

function spawnServer(entry, cwd, configPath) {
  const environment = nonSecretEnvironment({ TOOLSPAN_CONFIG: configPath });
  assert(
    !Object.keys(environment).some((name) => /(?:secret|token|password|credential|api.?key)/iu.test(name)),
    "Server child environment contains a credential-like variable",
  );
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logScanner = createHostLogSecretScanner();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    logScanner.write("stdout", chunk);
  });
  child.stderr.on("data", (chunk) => {
    logScanner.write("stderr", chunk);
  });
  return { child, logScanner };
}

async function waitForHealth(server, origin) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (server.child.exitCode !== null) {
      throw new Error(`Packed ToolSpan exited before health check (exit ${String(server.child.exitCode)})`);
    }
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.status === 200) return;
    } catch {
      // The loopback listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Packed ToolSpan health check timed out");
}

async function stopServer(server) {
  if (server === undefined || server.child.exitCode !== null) return;
  const exited = new Promise((resolve) => server.child.once("exit", resolve));
  server.child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!stopped && server.child.exitCode === null) {
    server.child.kill("SIGKILL");
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
}

async function fetchJson(url, options, expectedStatus) {
  const response = await fetch(url, options);
  assert(response.status === expectedStatus, `HTTP ${new URL(url).pathname} returned ${String(response.status)}`);
  const text = await response.text();
  try {
    return { response, body: JSON.parse(text) };
  } catch {
    throw new Error(`HTTP ${new URL(url).pathname} did not return JSON`);
  }
}

async function issueOAuthToken(origin, scopes, password) {
  const redirectUri = "http://127.0.0.1/toolspan-e2e-callback";
  const registered = await fetchJson(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "ToolSpan packed release E2E",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    }),
  }, 201);
  const clientId = registered.body.client_id;
  assert(typeof clientId === "string" && clientId.length > 0, "OAuth registration omitted client_id");

  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorization = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
    state: "toolspan-release-e2e",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
    password,
  });
  const approved = await fetch(`${origin}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: authorization,
    redirect: "manual",
  });
  assert(approved.status === 302, `OAuth authorization returned ${String(approved.status)}`);
  const location = approved.headers.get("location");
  assert(location !== null, "OAuth authorization omitted redirect location");
  const code = new URL(location).searchParams.get("code");
  assert(code !== null && code.length > 0, "OAuth authorization omitted code");

  const exchanged = await fetchJson(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: `${origin}/mcp`,
    }),
  }, 200);
  const accessToken = exchanged.body.access_token;
  const refreshToken = exchanged.body.refresh_token;
  assert(typeof accessToken === "string" && accessToken.length > 0, "OAuth token response omitted access token");
  assert(typeof refreshToken === "string" && refreshToken.length > 0, "OAuth token response omitted refresh token");
  assert(exchanged.body.scope === scopes.join(" "), "OAuth token scopes differ from the approved scopes");
  return {
    accessToken,
    secretValues: [password, verifier, challenge, code, accessToken, refreshToken],
  };
}

async function connectClient(origin, accessToken, name) {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

function structured(result, operation) {
  assert(result.isError !== true, `${operation} returned a tool error`);
  assert(
    typeof result.structuredContent === "object" && result.structuredContent !== null,
    `${operation} omitted structuredContent`,
  );
  return result.structuredContent;
}

async function callTool(client, name, arguments_) {
  return client.callTool({ name, arguments: arguments_ });
}

function assertSafeEvidence(evidence, secretValues) {
  const serialized = JSON.stringify(evidence);
  for (const secret of new Set(secretValues.filter((value) => typeof value === "string" && value.length > 0))) {
    assert(!serialized.includes(secret), "Release evidence contains a transient secret value");
  }
  assert(!/Bearer\s+[A-Za-z0-9._~+/-]+=*/u.test(serialized), "Release evidence contains a bearer credential");
  assert(!/[A-Za-z]:\\[^"\n]+/u.test(serialized), "Release evidence contains an absolute Windows path");
  assert(!serialized.includes(repositoryRoot), "Release evidence contains the repository absolute path");
}

function assertTemporaryDirectory(directory) {
  const base = path.resolve(tmpdir());
  const resolved = path.resolve(directory);
  const relative = path.relative(base, resolved);
  assert(
    relative.startsWith("toolspan-release-e2e-") &&
      !relative.includes(path.sep) &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative),
    "Refusing to remove an unowned temporary directory",
  );
}

async function writeEvidence(fileName, evidence, secretValues) {
  assert(path.basename(fileName) === fileName && fileName.endsWith(".json"), "Invalid evidence filename");
  assertSafeEvidence(evidence, secretValues);
  const evidenceDirectory = path.join(repositoryRoot, ".toolspan-dev", "evidence");
  await mkdir(evidenceDirectory, { recursive: true });
  const destination = path.join(evidenceDirectory, fileName);
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
  const persisted = await readFile(destination, "utf8");
  for (const secret of secretValues) assert(!persisted.includes(secret), "Persisted evidence contains a secret");
  return path.posix.join(".toolspan-dev", "evidence", fileName);
}

async function writeExternalHostEvidence(observedAt, proof, secretValues) {
  const evidence = {
    schemaVersion: "1.0",
    requirementId: "E-HOST-01",
    status: "PASS",
    observedAt,
    sanitized: true,
    secretValues: 0,
    proof,
  };
  assertSafeEvidence(evidence, secretValues);
  const evidenceDirectory = path.join(repositoryRoot, ".toolspan-dev", "evidence", "external");
  await mkdir(evidenceDirectory, { recursive: true });
  const destination = path.join(evidenceDirectory, "E-HOST-01.json");
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
  assertSafeEvidence(JSON.parse(await readFile(destination, "utf8")), secretValues);
  return path.posix.join(".toolspan-dev", "evidence", "external", "E-HOST-01.json");
}

async function installPackedRuntime(temporaryRoot) {
  const packDirectory = path.join(temporaryRoot, "pack");
  const hostDirectory = path.join(temporaryRoot, "host");
  await mkdir(packDirectory);
  await mkdir(hostDirectory);
  await runNpm(["run", "build"], repositoryRoot);
  const packed = await runNpm(["pack", "--json", "--pack-destination", packDirectory], repositoryRoot);
  const jsonStart = packed.stdout.indexOf("[");
  assert(jsonStart >= 0, "npm pack did not return its JSON manifest");
  const manifest = JSON.parse(packed.stdout.slice(jsonStart));
  assert(Array.isArray(manifest) && manifest.length === 1, "npm pack returned an unexpected manifest");
  const fileName = manifest[0]?.filename;
  assert(typeof fileName === "string" && path.basename(fileName) === fileName, "npm pack returned an unsafe filename");
  const tarball = path.join(packDirectory, fileName);
  await access(tarball, constants.R_OK);
  await writeFile(path.join(hostDirectory, "package.json"), "{\"private\":true}\n", "utf8");
  await runNpm([
    "install",
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--prefer-offline",
    tarball,
  ], hostDirectory);
  const installedRoot = path.join(hostDirectory, "node_modules", "toolspan-mcp");
  const installedPackage = await readJson(path.join(installedRoot, "package.json"));
  assert(installedPackage.name === "toolspan-mcp", "Packed install has the wrong package name");
  assert(typeof installedPackage.version === "string", "Packed install omitted package version");
  return { installedRoot, installedPackage };
}

export async function runPackedProtocolE2e({
  command = "npm run e2e:mcp-inspector",
  evidenceFileName = "release-e-host-01.json",
} = {}) {
  assert(
    command === "npm run e2e:mcp-inspector" || command === "npm run e2e:host:local",
    "Unsupported release E2E command label",
  );
  const fixtureRoot = await realpath(path.join(repositoryRoot, ...FIXTURE_RELATIVE_PATH.split("/")));
  const canonicalRepository = await realpath(repositoryRoot);
  assert(
    path.relative(canonicalRepository, fixtureRoot).split(path.sep).join("/") === FIXTURE_RELATIVE_PATH,
    "Release E2E fixture is not at the contracted tests/e2e-fixtures path",
  );

  const writablePath = path.join(fixtureRoot, "writable.txt");
  const jobOutputPath = path.join(fixtureRoot, "output", "job-result.txt");
  const sentinelPath = path.join(repositoryRoot, "README.md");
  const originalWritable = await readFile(writablePath, "utf8");
  const originalWritableHash = sha256(originalWritable);
  const sentinelBefore = sha256(await readFile(sentinelPath));
  let originalJobOutput;
  try {
    originalJobOutput = await readFile(jobOutputPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "toolspan-release-e2e-"));
  assertTemporaryDirectory(temporaryRoot);
  const secretValues = [];
  const clients = [];
  let server;
  let successfulEvidence;
  let inspectorProof;
  let temporaryRootRemoved = false;
  try {
    const { installedRoot, installedPackage } = await installPackedRuntime(temporaryRoot);
    const sdkPackage = await readJson(path.join(repositoryRoot, "node_modules", "@modelcontextprotocol", "sdk", "package.json"));
    assert(sdkPackage.version === SDK_VERSION, "Installed MCP SDK version differs from the pinned harness version");

    const password = `${randomBytes(36).toString("base64url")}!a9`;
    secretValues.push(password);
    const passwordHashFile = path.join(temporaryRoot, "secrets", "owner.bcrypt");
    const passwordInit = await runProcess(
      process.execPath,
      [path.join(installedRoot, "dist", "cli", "init-password.js"), "--file", passwordHashFile],
      { cwd: installedRoot, env: nonSecretEnvironment(), input: `${password}\n` },
    );
    assert(!passwordInit.stdout.includes(password) && !passwordInit.stderr.includes(password), "Password initializer logged plaintext");
    const persistedHash = (await readFile(passwordHashFile, "utf8")).trim();
    assert(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/u.test(persistedHash), "Password initializer did not persist bcrypt");
    assert(await compare(password, persistedHash), "Persisted bcrypt hash does not match stdin password");

    const port = await choosePort();
    const origin = `http://127.0.0.1:${String(port)}`;
    const configPath = path.join(temporaryRoot, "toolspan.synthetic.json");
    await writeFile(configPath, `${JSON.stringify({
      instanceName: INSTANCE_NAME,
      host: "127.0.0.1",
      port,
      publicBaseUrl: origin,
      allowedRoots: [fixtureRoot],
      stateDirectory: path.join(temporaryRoot, "state"),
      ownerPasswordHashFile: passwordHashFile,
    }, null, 2)}\n`, "utf8");

    server = spawnServer(path.join(installedRoot, "dist", "main.js"), installedRoot, configPath);
    await waitForHealth(server, origin);
    const inspectorSmoke = await runOfficialInspectorAuthSmoke(origin, temporaryRoot);
    const protectedMetadata = await fetchJson(`${origin}/.well-known/oauth-protected-resource`, {}, 200);
    const authorizationMetadata = await fetchJson(`${origin}/.well-known/oauth-authorization-server`, {}, 200);
    assert(protectedMetadata.body.resource === `${origin}/mcp`, "OAuth protected-resource metadata has the wrong resource");
    assert(
      authorizationMetadata.body.authorization_endpoint === `${origin}/oauth/authorize`,
      "OAuth authorization-server metadata has the wrong endpoint",
    );

    const inspectorAuthorized = await runOfficialInspectorAuthorizedSequence({
      origin,
      temporaryRoot,
      password,
      resolvedVersion: inspectorSmoke.resolvedVersion,
      fixtureRoot,
      originalWritable,
      originalWritableHash,
      writablePath,
    });
    inspectorProof = {
      kind: "MCP_INSPECTOR_E2E",
      inspectorPackage: "@modelcontextprotocol/inspector",
      inspectorVersion: inspectorSmoke.resolvedVersion,
      endpoint: `${origin}/mcp`,
      initializePassed: inspectorAuthorized.initializePassed,
      toolCount: inspectorAuthorized.toolCount,
      readPassed: inspectorAuthorized.readPassed,
      mutationPassed: inspectorAuthorized.mutationPassed,
      insufficientScopePassed: inspectorAuthorized.insufficientScopePassed,
    };
    await writeFile(writablePath, originalWritable, "utf8");
    if (originalJobOutput === undefined) await rm(jobOutputPath, { force: true });
    else await writeFile(jobOutputPath, originalJobOutput);
    assert(sha256(await readFile(writablePath, "utf8")) === originalWritableHash, "Inspector fixture reset failed");

    const fullAuthorization = await issueOAuthToken(
      origin,
      ["workspace:read", "workspace:write", "jobs:run", "artifacts:publish"],
      password,
    );
    secretValues.push(...fullAuthorization.secretValues);
    const full = await connectClient(origin, fullAuthorization.accessToken, "toolspan-release-e2e-full");
    clients.push(full.client);
    assert(full.transport.protocolVersion === PROTOCOL_VERSION, "MCP initialize negotiated an unexpected protocol version");
    assert(full.client.getServerVersion()?.name === "toolspan", "MCP initialize returned the wrong server identity");

    const tools = await full.client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    assert(JSON.stringify(toolNames) === JSON.stringify(EXPECTED_TOOLS), "tools/list differs from the exact 27-tool contract");
    assert(tools.nextCursor === undefined, "tools/list unexpectedly paginated the exact contract");

    const devspace = structured(await callTool(full.client, "devspace_info", {}), "devspace_info");
    assert(devspace.instanceName === INSTANCE_NAME, "devspace_info did not confirm the synthetic instance");
    const outsideOpen = await callTool(full.client, "open_workspace", { path: repositoryRoot });
    assert(outsideOpen.isError === true, "MCP opened the surrounding Codex repository outside the fixture root");

    const opened = structured(
      await callTool(full.client, "open_workspace", { path: fixtureRoot }),
      "open_workspace",
    );
    const workspaceId = opened.id;
    assert(typeof workspaceId === "string", "open_workspace omitted workspace id");
    const readme = structured(
      await callTool(full.client, "read", { workspaceId, path: "README.txt" }),
      "read README.txt",
    );
    assert(
      Array.isArray(readme.lines) && readme.lines.join("\n").includes("only allowed workspace root"),
      "OAuth-authorized read did not return the remote fixture",
    );

    const mutationProof = "toolspan-release-e2e-protocol-proof: applied\n";
    const mutatedWritable = `${originalWritable}${mutationProof}`;
    const patchArguments = {
      workspaceId,
      operations: [{
        op: "edit_file",
        path: "writable.txt",
        oldText: originalWritable,
        newText: mutatedWritable,
      }],
    };
    const dryRun = structured(
      await callTool(full.client, "apply_patch", { ...patchArguments, dryRun: true }),
      "apply_patch dry run",
    );
    assert(dryRun.dryRun === true && dryRun.applied === false, "apply_patch dry run mutated the fixture");
    assert(sha256(await readFile(writablePath, "utf8")) === originalWritableHash, "apply_patch dry run changed writable.txt");
    const applied = structured(
      await callTool(full.client, "apply_patch", { ...patchArguments, dryRun: false }),
      "apply_patch",
    );
    assert(applied.applied === true, "Authorized apply_patch was not applied");
    const writableAfterHash = sha256(await readFile(writablePath, "utf8"));
    assert(writableAfterHash !== originalWritableHash, "Authorized apply_patch did not change the fixture hash");
    const readback = structured(
      await callTool(full.client, "read", { workspaceId, path: "writable.txt" }),
      "read writable.txt after apply_patch",
    );
    assert(
      Array.isArray(readback.lines) && readback.lines.join("\n").includes("toolspan-release-e2e-protocol-proof: applied"),
      "MCP readback did not observe the authorized patch",
    );

    const started = structured(
      await callTool(full.client, "start_job", {
        workspaceId,
        runner: "npm",
        args: ["run", "toolspan:e2e"],
      }),
      "start_job",
    );
    assert(typeof started.id === "string", "start_job omitted job id");
    let polled;
    const pollDeadline = Date.now() + 60_000;
    do {
      polled = structured(
        await callTool(full.client, "poll_job", { jobId: started.id }),
        "poll_job",
      );
      if (FINAL_JOB_STATUSES.has(polled.job?.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < pollDeadline);
    assert(polled.job?.status === "completed", `Allowlisted fixture job ended as ${String(polled.job?.status)}`);
    const jobOutput = structured(
      await callTool(full.client, "read", { workspaceId, path: "output/job-result.txt" }),
      "read job output",
    );
    assert(
      Array.isArray(jobOutput.lines) && jobOutput.lines.join("\n").includes("toolspan-release-e2e-job: completed"),
      "Allowlisted job did not create the deterministic fixture output",
    );

    const readAuthorization = await issueOAuthToken(origin, ["workspace:read"], password);
    secretValues.push(...readAuthorization.secretValues);
    const readOnly = await connectClient(origin, readAuthorization.accessToken, "toolspan-release-e2e-read-only");
    clients.push(readOnly.client);
    const insufficient = await callTool(readOnly.client, "apply_patch", {
      workspaceId,
      operations: [{
        op: "edit_file",
        path: "writable.txt",
        oldText: mutatedWritable,
        newText: originalWritable,
      }],
      dryRun: false,
    });
    const authenticate = insufficient._meta?.["mcp/www_authenticate"];
    assert(
      insufficient.isError === true &&
        Array.isArray(authenticate) &&
        authenticate.some((entry) => typeof entry === "string" && entry.includes("insufficient_scope")),
      "Read-only OAuth token did not receive an insufficient_scope tool challenge",
    );
    assert(sha256(await readFile(writablePath, "utf8")) === writableAfterHash, "Insufficient-scope call changed the fixture");

    const sentinelAfter = sha256(await readFile(sentinelPath));
    assert(sentinelAfter === sentinelBefore, "A non-fixture repository sentinel changed during Host E2E");
    successfulEvidence = {
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      sanitized: true,
      command,
      protocolClient: {
        kind: "official-inspector-cli-and-pinned-sdk",
        package: "@modelcontextprotocol/sdk",
        version: SDK_VERSION,
        transport: "streamable-http",
        inspectorPackage: "@modelcontextprotocol/inspector",
        inspectorVersionSpec: "latest",
        inspectorResolvedVersion: inspectorSmoke.resolvedVersion,
        inspectorCliExecuted: true,
        inspectorResult: "authenticated_full_sequence",
        inspectorBoundaryExitCode: inspectorSmoke.exitCode,
        inspectorOauthCompleted: true,
        inspectorAuthStoresCreated: inspectorAuthorized.authStoresCreated,
        inspectorAuthStoreTemporary: true,
        inspectorAuthStoreRemoved: false,
        difference:
          "Official Inspector CLI completed OAuth, exact 27, read, write, job and insufficient-scope checks; the pinned SDK sequence remains auxiliary evidence.",
      },
      packedRuntime: {
        source: "npm-pack",
        installedFromTarball: true,
        packageName: installedPackage.name,
        packageVersion: installedPackage.version,
      },
      syntheticConfig: {
        instanceName: INSTANCE_NAME,
        bind: "127.0.0.1:ephemeral",
        publicBaseUrl: "loopback-http-ephemeral",
        allowedRoot: FIXTURE_RELATIVE_PATH,
        stateLocation: "isolated-temporary-directory",
        ownerCredentialPersistence: "bcrypt-hash-only",
        passwordProvisioning: "stdin-and-loopback-oauth-form-only",
        childEnvironment: "non-secret-allowlist",
      },
      checks: [
        { id: "packed-install", status: "PASS", detail: "npm pack tarball installed into an isolated host directory" },
        { id: "official-inspector-auth-boundary", status: "PASS", detail: "latest v2 CLI returned auth_required with exit code 3 and wrote no auth store" },
        { id: "official-inspector-oauth", status: "PASS", detail: "authorization-code PKCE completed through a loopback callback" },
        { id: "official-inspector-initialize", status: "PASS" },
        { id: "official-inspector-tools-list", status: "PASS", detail: "exact contracted set of 27 tools" },
        { id: "official-inspector-read", status: "PASS" },
        { id: "official-inspector-mutation", status: "PASS" },
        { id: "official-inspector-job", status: "PASS" },
        { id: "official-inspector-insufficient-scope", status: "PASS" },
        { id: "oauth-discovery", status: "PASS" },
        { id: "oauth-authorization-code-pkce", status: "PASS" },
        { id: "initialize", status: "PASS", detail: `negotiated ${PROTOCOL_VERSION}` },
        { id: "tools-list", status: "PASS", detail: "exact contracted set of 27 tools" },
        { id: "devspace-info", status: "PASS", detail: "synthetic instance identity confirmed" },
        { id: "outside-root-rejected", status: "PASS" },
        { id: "oauth-read", status: "PASS", detail: "README.txt read through MCP" },
        { id: "apply-patch-dry-run", status: "PASS" },
        { id: "apply-patch-authorized", status: "PASS" },
        { id: "apply-patch-readback", status: "PASS" },
        { id: "allowlisted-job-start", status: "PASS", detail: "npm runner used the versioned fixture script" },
        { id: "allowlisted-job-poll", status: "PASS", detail: "job completed" },
        { id: "allowlisted-job-output", status: "PASS" },
        { id: "insufficient-scope", status: "PASS", detail: "read-only token could not call apply_patch" },
        { id: "non-fixture-sentinel", status: "PASS", detail: "README.md digest remained unchanged" },
      ],
      fixtureIsolation: {
        targetRelativePath: FIXTURE_RELATIVE_PATH,
        allowedRootExact: true,
        outsideWorkspaceOpenRejected: true,
        nonFixtureSentinel: "README.md",
        nonFixtureSentinelUnchanged: true,
        writableSha256Before: originalWritableHash,
        writableSha256After: writableAfterHash,
        writableSha256Restored: originalWritableHash,
        directChangeObserved: true,
        protocolReadbackObserved: true,
        jobOutputWithinFixture: true,
      },
      secretSafety: {
        passwordInCommandLine: false,
        passwordPersistedAsPlaintext: false,
        secretValuesInEvidence: false,
        externalCredentialInheritedByServer: false,
        inspectorOauthStateTemporary: true,
        inspectorOauthStateValuesReadByHarness: false,
        inspectorOauthStateRemoved: false,
      },
      gates: {
        "E-HOST-01": {
          status: "PASS",
          basis: "Official Inspector v2 CLI completed authenticated initialize, exact 27, read, mutation, allowlisted job and insufficient-scope checks with temporary OAuth state removed after the run.",
        },
        "E-CODEX-01": {
          status: "EXTERNAL_GATE_PENDING",
          reason: "This local synthetic Host test does not prove a real remote Codex MCP connection or remote write target.",
        },
      },
    };
  } finally {
    try {
      for (const client of clients.reverse()) {
        try {
          await client.close();
        } catch {
          // Cleanup continues; a closed local listener does not change protocol evidence.
        }
      }
      await stopServer(server);
      await writeFile(writablePath, originalWritable, "utf8");
      if (originalJobOutput === undefined) await rm(jobOutputPath, { force: true });
      else await writeFile(jobOutputPath, originalJobOutput);
    } finally {
      assertTemporaryDirectory(temporaryRoot);
      await rm(temporaryRoot, { recursive: true, force: true });
      temporaryRootRemoved = true;
    }
  }

  assert(temporaryRootRemoved, "INSPECTOR_TEMPORARY_STATE_NOT_REMOVED");
  assert(successfulEvidence !== undefined, "Release Host E2E did not produce evidence");
  assert(inspectorProof !== undefined, "Official Inspector E2E did not produce a closed proof");
  assert(server !== undefined, "Release Host E2E server was not started");
  completeHostLogSecretSafety(successfulEvidence, server.logScanner, secretValues);
  const restoredHash = sha256(await readFile(writablePath, "utf8"));
  assert(restoredHash === originalWritableHash, "Release E2E fixture was not restored");
  successfulEvidence.fixtureIsolation.writableSha256Restored = restoredHash;
  successfulEvidence.checks.push({ id: "fixture-restored", status: "PASS" });
  try {
    await access(temporaryRoot);
    throw new Error("INSPECTOR_TEMPORARY_STATE_NOT_REMOVED");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  successfulEvidence.protocolClient.inspectorAuthStoreRemoved = true;
  successfulEvidence.secretSafety.inspectorOauthStateRemoved = true;
  successfulEvidence.checks.push({ id: "inspector-oauth-state-removed", status: "PASS" });
  const evidencePath = await writeEvidence(evidenceFileName, successfulEvidence, secretValues);
  const externalEvidencePath = await writeExternalHostEvidence(
    successfulEvidence.generatedAt,
    inspectorProof,
    secretValues,
  );
  return {
    status: "SMOKE_PASS",
    evidence: evidencePath,
    externalEvidence: externalEvidencePath,
    toolCount: EXPECTED_TOOLS.length,
    protocolVersion: PROTOCOL_VERSION,
    hostGate: "PASS",
    codexRemoteGate: "EXTERNAL_GATE_PENDING",
  };
}

export function publicHostError(error) {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{2,79}$/u.test(message) ? message : "HOST_E2E_FAILED";
}

async function main() {
  assert(process.argv.length === 2, "This command accepts no command-line arguments");
  const summary = await runPackedProtocolE2e();
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${publicHostError(error)}\n`);
    process.exitCode = 1;
  });
}
