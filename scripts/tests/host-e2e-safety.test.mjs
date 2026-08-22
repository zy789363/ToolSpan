import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import {
  completeHostLogSecretSafety,
  createHostLogSecretScanner,
  extractInspectorAuthorizationUrl,
} from "../e2e-mcp-inspector.mjs";

test("Inspector authorization URL extraction accepts only the expected loopback OAuth request", () => {
  const origin = "http://127.0.0.1:43123";
  const callback = "http://127.0.0.1:43124/oauth/callback";
  const authorization = new URL("/oauth/authorize", origin);
  authorization.search = new URLSearchParams({
    response_type: "code",
    client_id: "synthetic-client",
    redirect_uri: callback,
    scope: "workspace:read workspace:write jobs:run artifacts:publish",
    state: "synthetic-state",
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  }).toString();

  const output = `Authorize in browser: \u001b]8;;${authorization.href}\u0007${authorization.href}\u001b]8;;\u0007`;
  assert.equal(extractInspectorAuthorizationUrl(output, origin)?.href, authorization.href);
  assert.equal(extractInspectorAuthorizationUrl(output, "http://127.0.0.1:9999"), undefined);
  assert.equal(
    extractInspectorAuthorizationUrl(`Authorize: ${origin}/oauth/authorize?client_id=missing-fields`, origin),
    undefined,
  );
});

test("Host log scan detects a split transient Secret beyond 64 KiB without reflecting it", () => {
  const secret = "transient-owner-secret-value-that-must-not-be-reflected";
  const scanner = createHostLogSecretScanner();

  scanner.write("stdout", `${"x".repeat(70 * 1024)}${secret.slice(0, 17)}`);
  scanner.write("stdout", secret.slice(17));

  const result = scanner.finish([secret]);
  assert.deepEqual(result, {
    status: "FAIL",
    findings: [{ stream: "stdout", code: "KNOWN_TRANSIENT_VALUE" }],
  });
  assert.ok(!JSON.stringify(result).includes(secret));
});

test("Host log scan rejects a credential pattern split across chunks", () => {
  const scanner = createHostLogSecretScanner();

  scanner.write("stderr", "request header Authorization: Bea");
  scanner.write("stderr", "rer opaque-credential-value-123456789");

  assert.deepEqual(scanner.finish(), {
    status: "FAIL",
    findings: [{ stream: "stderr", code: "CREDENTIAL_PATTERN" }],
  });
});

test("Host log scan allows a standard Bearer resource-metadata challenge", () => {
  const scanner = createHostLogSecretScanner();
  scanner.write(
    "stdout",
    'WWW-Authenticate: Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource", error="insufficient_scope"',
  );
  assert.deepEqual(scanner.finish(), { status: "PASS", findings: [] });
});

test("Host evidence records clean logs only after the complete scan succeeds", () => {
  const unsafeEvidence = { secretSafety: {} };
  const unsafeScanner = createHostLogSecretScanner();
  unsafeScanner.write("stdout", "password=credential-value-that-must-not-leak");

  assert.throws(
    () => completeHostLogSecretSafety(unsafeEvidence, unsafeScanner, []),
    /HOST_LOG_SECRET_SCAN_FAILED/u,
  );
  assert.equal(Object.hasOwn(unsafeEvidence.secretSafety, "secretValuesLogged"), false);

  const safeEvidence = { secretSafety: {} };
  const safeScanner = createHostLogSecretScanner();
  safeScanner.write("stdout", "ToolSpan server ready");
  completeHostLogSecretSafety(safeEvidence, safeScanner, []);
  assert.equal(safeEvidence.secretSafety.secretValuesLogged, false);
});

test("local Host wrapper exposes only a static error code and exits nonzero", () => {
  const result = spawnSync(
    process.execPath,
    [path.resolve("scripts/e2e-host-local.mjs"), "unexpected-argument"],
    { cwd: path.resolve("."), encoding: "utf8", shell: false, windowsHide: true },
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "HOST_E2E_FAILED\n");
  assert.ok(!result.stderr.includes("command-line arguments"));
});
