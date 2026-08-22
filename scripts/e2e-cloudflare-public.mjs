import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runPackedProtocolE2e } from "./e2e-mcp-inspector.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const cloudflaredPath = path.join(repositoryRoot, ".toolspan-dev", "bin", "cloudflared.exe");
const cloudflaredSha256 = "c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5";
const publicOrigin = "https://mcp.aiqushi.top";
const localPort = 8787;

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

function checkedSessionId(value) {
  assert(typeof value === "string" && /^[0-9]{8}-[a-f0-9]{10}$/u.test(value), "SESSION_ID_INVALID");
  return value;
}

export function parsePublicCloudflareArguments(arguments_) {
  assert(arguments_.length === 2 && arguments_[0] === "--session", "COMMAND_LINE_ARGUMENT_REJECTED");
  return { sessionId: checkedSessionId(arguments_[1]) };
}

export function namedTunnelArguments() {
  return ["tunnel", "--no-autoupdate", "--protocol", "http2", "--loglevel", "info", "run"];
}

function allowedEnvironment(environment) {
  const allowed = new Set([
    "APPDATA", "COMSPEC", "HOME", "LOCALAPPDATA", "NUMBER_OF_PROCESSORS", "OS", "PATH",
    "PATHEXT", "PROCESSOR_ARCHITECTURE", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "WINDIR",
  ]);
  return Object.fromEntries(Object.entries(environment).filter(([name, value]) =>
    value !== undefined && allowed.has(name.toUpperCase())));
}

export function cloudflaredEnvironment(tunnelToken, isolatedHome, environment = process.env) {
  assert(typeof tunnelToken === "string" && tunnelToken.length >= 40, "TUNNEL_TOKEN_INVALID");
  return {
    ...allowedEnvironment(environment),
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: isolatedHome,
    LOCALAPPDATA: isolatedHome,
    TUNNEL_TOKEN: tunnelToken,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function assertPortAvailable() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(localPort, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

async function fetchTunnelToken(receipt, apiToken) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(receipt.zone.accountId)}`
      + `/cfd_tunnel/${encodeURIComponent(receipt.apply.ownedResources.find((item) => item.kind === "TUNNEL").id)}/token`,
    {
      headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" },
      redirect: "error",
    },
  );
  const document = await response.json();
  assert(response.status === 200 && document?.success === true, "TUNNEL_TOKEN_REQUEST_FAILED");
  assert(typeof document.result === "string" && document.result.length >= 40, "TUNNEL_TOKEN_RESPONSE_INVALID");
  return document.result;
}

function startCloudflared(tunnelToken, isolatedHome, secrets) {
  const args = namedTunnelArguments();
  assert(!args.some((argument) => secrets.some((secret) => argument.includes(secret))), "CREDENTIAL_IN_ARGUMENTS");
  let output = "";
  let registered = false;
  let resolveRegistered;
  let rejectRegistered;
  const registeredPromise = new Promise((resolve, reject) => {
    resolveRegistered = resolve;
    rejectRegistered = reject;
  });
  const child = spawn(cloudflaredPath, args, {
    cwd: isolatedHome,
    env: cloudflaredEnvironment(tunnelToken, isolatedHome),
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const inspect = (chunk) => {
    if (secrets.some((secret) => chunk.includes(secret))) {
      child.kill();
      rejectRegistered(new Error("CLOUDFLARED_LOGGED_SECRET"));
      return;
    }
    output = `${output}${chunk}`.slice(-256 * 1024);
    if (!registered && output.includes("Registered tunnel connection")) {
      registered = true;
      resolveRegistered();
    }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", inspect);
  child.stderr.on("data", inspect);
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (!registered) rejectRegistered(new Error(`CLOUDFLARED_EXIT_${String(code)}`));
      resolve({ code, signal });
    });
  });
  return { child, closed, registeredPromise, output: () => output };
}

async function stopManaged(managed) {
  if (managed === undefined || managed.child.exitCode !== null) return;
  managed.child.kill();
  await Promise.race([managed.closed, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (managed.child.exitCode === null) managed.child.kill();
}

async function writeEvidence(sessionId, evidence, secrets) {
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  assert(!secrets.some((secret) => serialized.includes(secret)), "PUBLIC_E2E_EVIDENCE_CONTAINS_SECRET");
  const directory = path.join(repositoryRoot, ".toolspan-dev", "evidence");
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, `cloudflare-public-e2e-${sessionId}.json`);
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, destination);
  return path.relative(repositoryRoot, destination).replaceAll("\\", "/");
}

export async function runPublicCloudflareE2E({ sessionId, environment = process.env } = {}) {
  const id = checkedSessionId(sessionId);
  const apiToken = environment.TOOLSPAN_E2E_CF_API_TOKEN;
  assert(typeof apiToken === "string" && apiToken.length >= 20, "SCOPED_TOKEN_NOT_PRESENT");
  const receiptPath = path.join(repositoryRoot, ".toolspan-dev", "evidence", `cloudflare-e2e-${id}.json`);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert(receipt.sessionId === id && receipt.credentialType === "SCOPED_API_TOKEN", "SCOPED_RECEIPT_INVALID");
  assert(receipt.apply?.status === "APPLIED" && receipt.apply?.checkpoint === "COMPLETE", "SCOPED_APPLY_NOT_COMPLETE");
  assert(receipt.secondRun?.status === "PASS" && receipt.secondRun?.mutationDelta === 0, "SCOPED_RECONCILE_NOT_COMPLETE");
  assert(receipt.cleanup?.status !== "PASS", "SCOPED_RESOURCES_ALREADY_CLEANED");
  const tunnel = receipt.apply.ownedResources.find((item) => item.kind === "TUNNEL");
  const dns = receipt.apply.ownedResources.find((item) => item.kind === "DNS_CNAME");
  assert(tunnel !== undefined && dns !== undefined, "SCOPED_OWNERSHIP_INCOMPLETE");
  await access(cloudflaredPath, constants.X_OK);
  assert(sha256(await readFile(cloudflaredPath)) === cloudflaredSha256, "CLOUDFLARED_HASH_MISMATCH");
  await assertPortAvailable();

  const tunnelToken = await fetchTunnelToken(receipt, apiToken);
  const secrets = [apiToken, tunnelToken];
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "toolspan-cloudflare-public-"));
  let cloudflared;
  let hostResult;
  let hostPhase = "NOT_STARTED";
  try {
    cloudflared = startCloudflared(tunnelToken, temporaryRoot, secrets);
    await Promise.race([
      cloudflared.registeredPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("CLOUDFLARED_REGISTER_TIMEOUT")), 60_000)),
    ]);
    try {
      hostResult = await runPackedProtocolE2e({
        command: "npm run e2e:cloudflare-public",
        evidenceFileName: `cloudflare-public-host-${id}.json`,
        publicOrigin,
        fixedPort: localPort,
        writeExternalHostEvidence: false,
        skipInspectorAuthBoundary: true,
        onPhase(phase) { hostPhase = phase; },
      });
    } catch {
      throw new Error(`PUBLIC_HOST_${hostPhase}_FAILED`);
    }
    assert(hostResult.status === "SMOKE_PASS" && hostResult.toolCount === 27, "PUBLIC_HOST_SEQUENCE_INCOMPLETE");
    assert(hostResult.publicOrigin === publicOrigin && hostResult.publicHealthPassed === true
      && hostResult.oauthDiscoveryPassed === true, "PUBLIC_HOST_ASSERTIONS_INCOMPLETE");
  } finally {
    await stopManaged(cloudflared);
    if (cloudflared !== undefined) {
      assert(!secrets.some((secret) => cloudflared.output().includes(secret)), "CLOUDFLARED_LOGGED_SECRET");
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  const evidence = {
    schemaVersion: "1.0",
    evidenceType: "TOOLSPAN_CLOUDFLARE_PUBLIC_E2E",
    generatedAt: new Date().toISOString(),
    sanitized: true,
    secretValues: 0,
    sessionId: id,
    publicEndpoint: `${publicOrigin}/mcp`,
    publicHealthPassed: true,
    oauthDiscoveryPassed: true,
    publicToolCount: hostResult.toolCount,
    cloudflared: {
      binarySha256: cloudflaredSha256,
      tokenSource: "TUNNEL_TOKEN_ENVIRONMENT",
      credentialInArguments: false,
      credentialInFile: false,
      registered: true,
      stopped: true,
    },
    hostEvidence: hostResult.evidence,
  };
  const evidencePath = await writeEvidence(id, evidence, secrets);
  return { status: "PASS", evidence: evidencePath, publicEndpoint: evidence.publicEndpoint, toolCount: 27 };
}

function publicError(error) {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{2,79}$/u.test(message) ? message : "CLOUDFLARE_PUBLIC_E2E_FAILED";
}

async function main() {
  const { sessionId } = parsePublicCloudflareArguments(process.argv.slice(2));
  const result = await runPublicCloudflareE2E({ sessionId });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${publicError(error)}\n`);
    process.exitCode = 1;
  });
}
