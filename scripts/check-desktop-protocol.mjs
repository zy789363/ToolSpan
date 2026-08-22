import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(root, "schemas", "desktop-protocol.v1.schema.json");
const requestFixturePath = path.join(root, "tests", "fixtures", "desktop-protocol-v1", "hello.request.jsonl");
const responseFixturePath = path.join(root, "tests", "fixtures", "desktop-protocol-v1", "hello.response.jsonl");
const rendererFixturePath = path.join(root, "tests", "fixtures", "desktop-protocol-v1", "renderer-raw-results.json");
const hostEntryPath = path.join(root, "dist", "desktop-host", "main.js");

const expectedMethods = [
  "system.hello",
  "runtime.getSnapshot",
  "runtime.start",
  "runtime.stop",
  "runtime.restart",
  "runtime.validateConfig",
  "runtime.getConfigSummary",
  "runtime.listJobs",
  "runtime.cancelJob",
  "runtime.listArtifacts",
  "runtime.getLogChunk",
  "runtime.subscribeEvents",
  "connection.testLocal",
  "connection.testPublic",
  "setup.getSnapshot",
  "setup.preflight",
  "setup.plan",
  "setup.apply",
  "setup.rollback",
  "setup.reconcile",
  "setup.discardCredential",
];

function collectMethodConstants(value, methods = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectMethodConstants(item, methods);
  } else if (value !== null && typeof value === "object") {
    if (typeof value.properties?.method?.const === "string") {
      methods.add(value.properties.method.const);
    }
    for (const child of Object.values(value)) collectMethodConstants(child, methods);
  }
  return methods;
}

async function runFixture(input) {
  const child = spawn(process.execPath, ["--no-warnings", hostEntryPath], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { exitCode, stdout, stderr };
}

const [schemaText, requestFixture, responseFixture, rendererFixtureText, packageText] = await Promise.all([
  readFile(schemaPath, "utf8"),
  readFile(requestFixturePath, "utf8"),
  readFile(responseFixturePath, "utf8"),
  readFile(rendererFixturePath, "utf8"),
  readFile(path.join(root, "package.json"), "utf8"),
]);
const schema = JSON.parse(schemaText);
const rendererFixture = JSON.parse(rendererFixtureText);
const packageJson = JSON.parse(packageText);
assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
assert.deepEqual([...collectMethodConstants(schema)].sort(), [...expectedMethods].sort());

const request = JSON.parse(requestFixture.trim());
const expectedResponse = JSON.parse(responseFixture.trim());
assert.equal(request.params.protocolVersion, 1);
assert.equal(expectedResponse.result.productVersion, packageJson.version);
assert.deepEqual(expectedResponse.result.capabilities, [
  "runtime",
  "connection",
  "jobs",
  "artifacts",
  "logs",
  "setup",
]);
assert.deepEqual(Object.keys(schema.$defs.setupManifest.properties).sort(), [
  "desiredHostname",
  "domainChoice",
  "expectedToolCount",
  "generatedAt",
  "instanceName",
  "localUrl",
  "oauthDiscoveryUrl",
  "officialDocs",
  "publicMcpUrl",
  "schemaVersion",
  "toolSpanVersion",
  "tunnelName",
]);
assert.equal(schema.$defs.setupManifest.properties.schemaVersion.const, "1.0");
assert.deepEqual(Object.keys(schema.$defs.setupPreflightRequest.properties.params.properties).sort(), [
  "credential",
  "idempotencyKey",
  "manifest",
  "sessionId",
  "zoneName",
]);
assert.deepEqual(Object.keys(rendererFixture).sort(), [
  "runtime.getLogChunk",
  "runtime.getSnapshot",
  "runtime.listArtifacts",
  "runtime.listJobs",
  "setup.getSnapshot",
]);
assert.equal(rendererFixture["runtime.getSnapshot"].recentJobs[0].status, "completed");
assert.ok(Array.isArray(rendererFixture["runtime.listJobs"].jobs));
assert.ok(Array.isArray(rendererFixture["runtime.listArtifacts"].artifacts));
assert.equal(typeof rendererFixture["runtime.getLogChunk"].chunk, "string");
assert.equal(rendererFixture["setup.getSnapshot"], null);
for (const definition of [
  "runtimeSnapshotResult",
  "rendererSnapshotResult",
  "jobsResult",
  "artifactsResult",
  "logChunkResult",
  "setupSnapshotResult",
  "setupDiscardResult",
]) assert.ok(schema.$defs[definition], `schema is missing ${definition}`);

const result = await runFixture(requestFixture);
assert.equal(result.exitCode, 0);
assert.equal(result.stderr, "");
assert.equal(result.stdout, responseFixture);
for (const line of result.stdout.trimEnd().split("\n")) JSON.parse(line);

process.stdout.write("Desktop protocol v1: PASS (21 methods, backward-compatible v0.5 setup additions, schema, host + Renderer fixtures, fixed host entry)\n");
