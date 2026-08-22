import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cloudflareE2EExitCode,
  resolveCredentialFromEnvironment,
  runCloudflareE2E,
  scanSanitizedEvidence,
  validateReconcileReceipt,
} from "../e2e-cloudflare.mjs";

const ACCOUNT_ID = "a".repeat(32);
const ZONE_ID = "b".repeat(32);
const TUNNEL_ID = "11111111-2222-3333-4444-555555555555";
const DNS_ID = "c".repeat(32);
const SESSION_ID = "20260821-abcde12345";
const DESIRED_TUNNEL = `toolspan-e2e-${SESSION_ID}`;

const envNames = {
  apiToken: "TOOLSPAN_E2E_CF_API_TOKEN",
  globalEmail: "TOOLSPAN_E2E_CF_GLOBAL_EMAIL",
  globalKey: "CloudFlareAPIKEY",
};

function manifest(credentialType) {
  return {
    schemaVersion: "2.0",
    cloudflare: {
      available: true,
      zoneName: "aiqushi.top",
      preferredHostname: "mcp.aiqushi.top",
      zoneId: null,
      accountId: null,
      zoneStatus: "UNKNOWN",
      credentialAvailable: true,
      credentialType,
      apiTokenEnv: envNames.apiToken,
      globalEmailEnv: envNames.globalEmail,
      globalKeyEnv: envNames.globalKey,
    },
    browserAutomation: {
      chromeAuthorized: true,
      computerUseAuthorized: true,
      humanCredentialEntryRequired: true,
      humanConsequentialConfirmationRequired: true,
    },
    chatgpt: {
      currentAccountAvailable: true,
      businessWorkspaceRequired: false,
      developerModeVisible: null,
      customMcpUiReachable: null,
      writeValidationRequired: false,
    },
    windows: {
      nativeVmAvailable: true,
      adminRights: false,
    },
    secondaryHost: {
      name: "Codex",
      available: true,
      writeE2eRequired: true,
    },
  };
}

function envelope(result, options = {}) {
  return new Response(JSON.stringify({
    success: options.success ?? true,
    result,
    errors: options.errors ?? [],
    ...(options.pages === undefined ? {} : {
      result_info: { page: 1, total_pages: options.pages },
    }),
  }), {
    status: options.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function createCloudflareMock(options = {}) {
  const state = {
    zoneStatus: options.zoneStatus ?? "active",
    dns: structuredClone(options.dns ?? []),
    tunnels: structuredClone(options.tunnels ?? []),
    config: null,
    calls: [],
    mutations: [],
    globalUserEmail: options.globalUserEmail ?? null,
  };
  const responseConfig = () => {
    const config = structuredClone(state.config);
    if (typeof options.warpRoutingEnabled === "boolean") {
      config["warp-routing"] = { enabled: options.warpRoutingEnabled };
    }
    return config;
  };
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const headers = init.headers;
    state.calls.push({ url, method, headers });
    const apiPath = url.pathname.replace("/client/v4", "");

    if (method === "GET" && apiPath === "/user/tokens/verify") return envelope({ status: "active" });
    if (method === "GET" && apiPath === "/user") return envelope({ email: state.globalUserEmail });
    if (method === "GET" && apiPath === "/zones") {
      return envelope([{
        id: ZONE_ID,
        name: "aiqushi.top",
        status: state.zoneStatus,
        account: { id: ACCOUNT_ID },
        name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
      }], { pages: 1 });
    }
    if (method === "GET" && apiPath === `/zones/${ZONE_ID}/dns_records`) {
      const queriedName = url.searchParams.get("name");
      return envelope(state.dns.filter((record) => queriedName === null || record.name === queriedName), { pages: 1 });
    }
    if (method === "GET" && apiPath === `/accounts/${ACCOUNT_ID}/cfd_tunnel`) {
      return envelope(state.tunnels, { pages: 1 });
    }
    if (method === "POST" && apiPath === `/accounts/${ACCOUNT_ID}/cfd_tunnel`) {
      await options.beforeMutation?.({ resource: "TUNNEL", method });
      const body = JSON.parse(String(init.body));
      const created = { id: TUNNEL_ID, name: body.name, status: "inactive" };
      state.tunnels.push(created);
      state.mutations.push({ method, resource: "TUNNEL", id: TUNNEL_ID });
      if (options.responseLostOn === "TUNNEL") throw new Error("simulated response loss");
      return envelope(created);
    }
    if (method === "PUT" && apiPath === `/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations`) {
      await options.beforeMutation?.({ resource: "TUNNEL_CONFIG", method });
      state.config = JSON.parse(String(init.body)).config;
      state.mutations.push({ method, resource: "TUNNEL_CONFIG", id: TUNNEL_ID });
      if (options.missingTunnelConfigResponse === true) return envelope({});
      if (options.reorderedTunnelConfigResponse === true) {
        return envelope({
          config: {
            ingress: state.config.ingress.map((rule) => rule.hostname === undefined
              ? { service: rule.service }
              : { service: rule.service, hostname: rule.hostname }),
          },
        });
      }
      return envelope({ config: responseConfig() });
    }
    if (method === "GET" && new RegExp(`^/accounts/${ACCOUNT_ID}/cfd_tunnel/[^/]+/configurations$`, "u").test(apiPath)) {
      return envelope({ config: responseConfig() });
    }
    if (method === "POST" && apiPath === `/zones/${ZONE_ID}/dns_records`) {
      await options.beforeMutation?.({ resource: "DNS_CNAME", method });
      const body = JSON.parse(String(init.body));
      const created = { id: DNS_ID, ...body, ...options.createdDnsOverrides };
      state.dns.push(created);
      state.mutations.push({ method, resource: "DNS_CNAME", id: DNS_ID });
      return envelope(created);
    }
    if (method === "DELETE" && apiPath === `/zones/${ZONE_ID}/dns_records/${DNS_ID}`) {
      if (options.responseLostOn === "DNS_DELETE_VISIBLE") throw new Error("simulated delete response loss");
      state.dns = state.dns.filter((record) => record.id !== DNS_ID);
      state.mutations.push({ method, resource: "DNS_CNAME", id: DNS_ID });
      await options.afterDnsDelete?.(state);
      return envelope(options.dnsDeleteResponse ?? { id: DNS_ID });
    }
    if (method === "DELETE" && apiPath === `/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}`) {
      state.tunnels = state.tunnels.filter((record) => record.id !== TUNNEL_ID);
      state.mutations.push({ method, resource: "TUNNEL", id: TUNNEL_ID });
      return envelope(options.tunnelDeleteResponse ?? { id: TUNNEL_ID });
    }
    throw new Error(`Unexpected mock request: ${method} ${apiPath}`);
  };
  return { fetch, state };
}

function scopedEnvironment() {
  const value = ["unit", "scoped", "credential", "value"].join("-");
  return { environment: { [envNames.apiToken]: value }, sensitive: value };
}

function fixedRunOptions(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    clock: () => new Date("2026-08-21T00:00:00.000Z"),
    randomBytes: (length) => Buffer.alloc(length, 0xab),
    sleep: async () => undefined,
    writeEvidence: false,
    ...overrides,
  };
}

test("UNKNOWN credential type stops without guessing or reading any credential", async () => {
  let environmentReads = 0;
  const environment = new Proxy({}, {
    get() {
      environmentReads += 1;
      throw new Error("credential environment must not be read");
    },
  });
  let fetchCalls = 0;
  const result = await runCloudflareE2E(fixedRunOptions({
    manifest: manifest("UNKNOWN"),
    environment,
    fetch: async () => { fetchCalls += 1; throw new Error("must not fetch"); },
  }));
  assert.equal(result.evidence.status, "NEEDS_HUMAN_CHECKPOINT");
  assert.equal(result.evidence.reason, "CREDENTIAL_TYPE_SELECTION_REQUIRED");
  assert.equal(environmentReads, 0);
  assert.equal(fetchCalls, 0);
});

test("CLI outcome classes use distinct release-safe exit codes", () => {
  assert.equal(cloudflareE2EExitCode({ status: "PASS" }), 0);
  assert.equal(cloudflareE2EExitCode({ status: "FAIL" }), 1);
  assert.equal(cloudflareE2EExitCode({ status: "BLOCKED_BY_ENVIRONMENT" }), 2);
  assert.equal(cloudflareE2EExitCode({ status: "BLOCKED_BY_EXTERNAL_ACCOUNT" }), 2);
  assert.equal(cloudflareE2EExitCode({ status: "NEEDS_HUMAN_CHECKPOINT" }), 3);
});

test("reconcile accepts only a non-secret session id and derives its receipt path internally", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    runCloudflareE2E(fixedRunOptions({
      mode: "RECONCILE",
      sessionId: "../arbitrary-receipt.json",
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("must not fetch");
      },
    })),
    { message: "SESSION_ID_INVALID" },
  );
  assert.equal(fetchCalls, 0);

  const directory = await mkdtemp(path.join(os.tmpdir(), "toolspan-cf-fixed-receipt-"));
  try {
    const missing = await runCloudflareE2E(fixedRunOptions({
      mode: "RECONCILE",
      writeEvidence: true,
      evidenceDirectory: directory,
    }));
    assert.equal(missing.evidence.reason, "RECONCILE_RECEIPT_MISSING");
    assert.equal(missing.evidencePath, null);
    await assert.rejects(
      readFile(path.join(directory, `cloudflare-e2e-${SESSION_ID}.json`), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an invalid v2 manifest stops before any environment read or network request", async () => {
  const invalid = manifest("SCOPED_API_TOKEN");
  invalid.cloudflare.apiTokenEnv = "AWS_SECRET_ACCESS_KEY";
  let environmentReads = 0;
  const environment = new Proxy({}, {
    get() {
      environmentReads += 1;
      return ["unit", "unrelated", "environment", "value"].join("-");
    },
  });
  let fetchCalls = 0;
  const result = await runCloudflareE2E(fixedRunOptions({
    manifest: invalid,
    environment,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    },
  }));
  assert.equal(result.evidence.status, "FAIL");
  assert.equal(result.evidence.reason, "TEST_ENVIRONMENT_V2_INVALID");
  assert.equal(environmentReads, 0);
  assert.equal(fetchCalls, 0);
});

test("credential references are limited to the three canonical environment names", async () => {
  const invalid = manifest("GLOBAL_API_KEY");
  invalid.cloudflare.globalKeyEnv = "TOOLSPAN_E2E_CF_GLOBAL_KEY";
  let environmentReads = 0;
  const environment = new Proxy({}, {
    get() {
      environmentReads += 1;
      throw new Error("credential environment must not be read");
    },
  });
  const result = await runCloudflareE2E(fixedRunOptions({
    manifest: invalid,
    environment,
    fetch: async () => { throw new Error("must not fetch"); },
  }));
  assert.equal(result.evidence.reason, "TEST_ENVIRONMENT_V2_INVALID");
  assert.equal(environmentReads, 0);
});

test("Global Key mode checks the email first and never dereferences the Key when email is absent", () => {
  const keyValue = ["unit", "global", "credential", "value"].join("-");
  let keyReads = 0;
  const environment = new Proxy({ [envNames.globalKey]: keyValue }, {
    get(target, property, receiver) {
      if (property === envNames.globalKey) keyReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const result = resolveCredentialFromEnvironment(manifest("GLOBAL_API_KEY").cloudflare, environment);
  assert.equal(result.checkpoint, "GLOBAL_KEY_EMAIL_ENV_VALUE_REQUIRED");
  assert.equal(keyReads, 0);
  assert.deepEqual(result.sensitiveValues, []);
});

test("every credential value is registered before validation and escaped reflection is rejected", () => {
  const invalidToken = ` ${["credential", "with\nquote\"", "value"].join("-")}`;
  const scoped = resolveCredentialFromEnvironment(manifest("SCOPED_API_TOKEN").cloudflare, {
    [envNames.apiToken]: invalidToken,
  });
  assert.equal(scoped.checkpoint, "SCOPED_TOKEN_ENV_VALUE_INVALID");
  assert.deepEqual(scoped.sensitiveValues, [invalidToken]);
  assert.equal(scanSanitizedEvidence({ reflected: invalidToken }, scoped.sensitiveValues).status, "FAIL");
  const escaped = JSON.stringify(invalidToken).slice(1, -1);
  assert.equal(scanSanitizedEvidence({ reflected: escaped }, scoped.sensitiveValues).status, "FAIL");

  const email = ["owner", "example.test"].join("@");
  const invalidKey = "short-key";
  const global = resolveCredentialFromEnvironment(manifest("GLOBAL_API_KEY").cloudflare, {
    [envNames.globalEmail]: email,
    [envNames.globalKey]: invalidKey,
  });
  assert.equal(global.checkpoint, "GLOBAL_KEY_ENV_VALUE_INVALID");
  assert.deepEqual(global.sensitiveValues, [email, invalidKey]);
});

test("Scoped read-only preflight resolves the fixed active target and persists only sanitized evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolspan-cf-evidence-"));
  try {
    const { environment, sensitive } = scopedEnvironment();
    const mock = createCloudflareMock();
    const result = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      writeEvidence: true,
      evidenceDirectory: directory,
    }));
    assert.equal(result.evidence.status, "NEEDS_HUMAN_CHECKPOINT");
    assert.equal(result.evidence.decision, "DRY_RUN_READY");
    assert.equal(result.evidence.reason, "CHECKPOINT_CLOUDFLARE_APPLY");
    assert.equal(result.evidence.zone.status, "ACTIVE");
    assert.equal(result.evidence.zone.id, ZONE_ID);
    assert.equal(result.evidence.zone.accountId, ACCOUNT_ID);
    assert.equal(result.evidence.dryRun.mutationCount, 3);
    assert.equal(result.evidence.dryRun.createCount, 2);
    assert.ok(result.evidence.apiRequests.every((entry) => entry.method === "GET"));
    assert.equal(mock.state.mutations.length, 0);
    const serialized = JSON.stringify(result.evidence);
    const persisted = await readFile(result.evidencePath, "utf8");
    assert.ok(!serialized.includes(sensitive));
    assert.ok(!persisted.includes(sensitive));
    assert.deepEqual(scanSanitizedEvidence(result.evidence, [sensitive]), {
      status: "PASS",
      forbiddenFieldCount: 0,
      matchedSecretValues: 0,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Global Key + email uses only X-Auth headers and never reports either value", async () => {
  const email = ["owner", "example.test"].join("@");
  const key = ["unit", "global", "credential", "value"].join("-");
  const mock = createCloudflareMock({ globalUserEmail: email.toUpperCase() });
  const result = await runCloudflareE2E(fixedRunOptions({
    manifest: manifest("GLOBAL_API_KEY"),
    environment: { [envNames.globalEmail]: email, [envNames.globalKey]: key },
    fetch: mock.fetch,
  }));
  assert.equal(result.evidence.decision, "DRY_RUN_READY");
  const firstHeaders = mock.state.calls[0].headers;
  assert.equal(firstHeaders.get("X-Auth-Email"), email);
  assert.equal(firstHeaders.get("X-Auth-Key"), key);
  assert.equal(firstHeaders.get("Authorization"), null);
  const serialized = JSON.stringify(result.evidence);
  assert.ok(!serialized.includes(email));
  assert.ok(!serialized.includes(key));
});

test("a non-active zone is fully inspected read-only and hard-stops before Apply", async () => {
  const { environment } = scopedEnvironment();
  const mock = createCloudflareMock({
    zoneStatus: "pending",
    dns: [{ id: "d".repeat(32), type: "A", name: "mcp.aiqushi.top", content: "192.0.2.1" }],
    tunnels: [{ id: "22222222-3333-4444-5555-666666666666", name: "toolspan-e2e-old", status: "inactive" }],
  });
  const result = await runCloudflareE2E(fixedRunOptions({
    manifest: manifest("SCOPED_API_TOKEN"),
    environment,
    fetch: mock.fetch,
  }));
  assert.equal(result.evidence.status, "NEEDS_HUMAN_CHECKPOINT");
  assert.equal(result.evidence.reason, "ZONE_NOT_ACTIVE");
  assert.equal(result.evidence.zone.status, "PENDING");
  assert.equal(result.evidence.dnsInspection.collision, true);
  assert.equal(result.evidence.tunnelInspection.prefixedCount, 1);
  assert.ok(result.evidence.dryRun.blockers.includes("ZONE_NOT_ACTIVE"));
  assert.equal(mock.state.mutations.length, 0);
});

test("unknown DNS or desired tunnel ownership blocks all mutation", async () => {
  const { environment } = scopedEnvironment();
  const mock = createCloudflareMock({
    dns: [{ id: "d".repeat(32), type: "CNAME", name: "mcp.aiqushi.top", content: "unknown.example.test" }],
    tunnels: [{ id: "22222222-3333-4444-5555-666666666666", name: DESIRED_TUNNEL, status: "inactive" }],
  });
  const result = await runCloudflareE2E(fixedRunOptions({
    manifest: manifest("SCOPED_API_TOKEN"),
    environment,
    fetch: mock.fetch,
    mode: "APPLY",
    enableApply: true,
    confirmationChannel: async ({ expected }) => expected,
  }));
  assert.equal(result.evidence.reason, "UNKNOWN_RESOURCE_COLLISION");
  assert.equal(result.evidence.apply.attempted, false);
  assert.equal(mock.state.mutations.length, 0);
});

test("a preferred-hostname collision selects a clean session fallback without overwriting", async () => {
  const { environment } = scopedEnvironment();
  const preferredRecord = {
    id: "d".repeat(32),
    type: "CNAME",
    name: "mcp.aiqushi.top",
    content: "unknown.example.test",
  };
  const mock = createCloudflareMock({ dns: [preferredRecord] });
  const result = await runCloudflareE2E(fixedRunOptions({
    manifest: manifest("SCOPED_API_TOKEN"),
    environment,
    fetch: mock.fetch,
  }));
  assert.equal(result.evidence.decision, "DRY_RUN_READY");
  assert.equal(result.evidence.target.preferredHostname, "mcp.aiqushi.top");
  assert.equal(result.evidence.target.hostname, `mcp-e2e-${SESSION_ID}.aiqushi.top`);
  assert.equal(result.evidence.target.hostnameSelection, "SESSION_FALLBACK");
  assert.equal(result.evidence.dnsInspection.collision, false);
  assert.equal(result.evidence.dryRun.executable, true);
  assert.deepEqual(mock.state.dns, [preferredRecord]);
  assert.equal(mock.state.mutations.length, 0);
});

test("an unknown session-fallback collision hard-stops without mutation", async () => {
  const { environment } = scopedEnvironment();
  const fallback = `mcp-e2e-${SESSION_ID}.aiqushi.top`;
  const mock = createCloudflareMock({
    dns: [
      { id: "d".repeat(32), type: "CNAME", name: "mcp.aiqushi.top", content: "unknown.example.test" },
      { id: "e".repeat(32), type: "A", name: fallback, content: "192.0.2.10" },
    ],
  });
  const result = await runCloudflareE2E(fixedRunOptions({
    manifest: manifest("SCOPED_API_TOKEN"),
    environment,
    fetch: mock.fetch,
  }));
  assert.equal(result.evidence.status, "NEEDS_HUMAN_CHECKPOINT");
  assert.equal(result.evidence.reason, "UNKNOWN_RESOURCE_COLLISION");
  assert.equal(result.evidence.target.hostname, fallback);
  assert.equal(result.evidence.dnsInspection.collision, true);
  assert.equal(mock.state.mutations.length, 0);
});

test("Apply remains disabled by default even after a clean Dry Run", async () => {
  const { environment } = scopedEnvironment();
  const mock = createCloudflareMock();
  const result = await runCloudflareE2E(fixedRunOptions({
    manifest: manifest("SCOPED_API_TOKEN"),
    environment,
    fetch: mock.fetch,
    mode: "APPLY",
    enableApply: false,
    confirmationChannel: async () => { throw new Error("must not prompt"); },
  }));
  assert.equal(result.evidence.reason, "APPLY_DISABLED_BY_DEFAULT");
  assert.equal(result.evidence.apply.confirmationStatus, "REQUIRED");
  assert.equal(mock.state.mutations.length, 0);
});

test("Apply rejects a missing or incorrect one-time confirmation without mutation", async () => {
  const { environment } = scopedEnvironment();
  const mock = createCloudflareMock();
  const result = await runCloudflareE2E(fixedRunOptions({
    manifest: manifest("SCOPED_API_TOKEN"),
    environment,
    fetch: mock.fetch,
    mode: "APPLY",
    enableApply: true,
    confirmationChannel: async () => "not-the-issued-confirmation",
  }));
  assert.equal(result.evidence.reason, "CHECKPOINT_CLOUDFLARE_APPLY");
  assert.equal(result.evidence.apply.confirmationStatus, "REQUIRED");
  assert.equal(mock.state.mutations.length, 0);
});

test("Apply presents the exact sanitized plan before the first non-GET request", async () => {
  const { environment } = scopedEnvironment();
  const mock = createCloudflareMock();
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolspan-cf-plan-"));
  try {
    let presented = null;
    const result = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "APPLY",
      enableApply: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async ({ expected, summary }) => {
        assert.equal(mock.state.mutations.length, 0);
        assert.ok(mock.state.calls.every((call) => call.method === "GET"));
        presented = structuredClone(summary);
        return expected;
      },
    }));
    assert.equal(result.evidence.reason, "SECOND_INVOCATION_REQUIRED");
    assert.deepEqual(presented.zone, {
      name: "aiqushi.top",
      id: ZONE_ID,
      accountId: ACCOUNT_ID,
      status: "ACTIVE",
    });
    assert.equal(presented.hostname, "mcp.aiqushi.top");
    assert.equal(presented.tunnelName, DESIRED_TUNNEL);
    assert.equal(presented.planHash, result.evidence.dryRun.planHash);
    assert.equal(presented.confirmationHash, result.evidence.dryRun.planHash);
    assert.match(presented.planHash, /^[a-f0-9]{64}$/u);
    assert.deepEqual(presented.plan, result.evidence.dryRun);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the confirmed plan binds zone, account, and the exact inspected resource set", async () => {
  const { environment } = scopedEnvironment();
  const mock = createCloudflareMock();
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolspan-cf-race-"));
  try {
    let presented = null;
    const result = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "APPLY",
      enableApply: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async ({ expected, summary }) => {
        presented = structuredClone(summary);
        mock.state.tunnels.push({
          id: "99999999-aaaa-bbbb-cccc-dddddddddddd",
          name: "toolspan-e2e-race-unknown",
          status: "inactive",
        });
        return expected;
      },
    }));
    assert.equal(result.evidence.reason, "TARGET_CHANGED_AFTER_CONFIRMATION");
    assert.equal(mock.state.mutations.length, 0);
    assert.equal(result.evidence.dryRun.zoneId, ZONE_ID);
    assert.equal(result.evidence.dryRun.accountId, ACCOUNT_ID);
    assert.match(result.evidence.dryRun.inspectionFingerprint, /^[a-f0-9]{64}$/u);
    assert.deepEqual(presented.plan, result.evidence.dryRun);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Apply exposes an atomic, sanitized recovery checkpoint before every mutation", async () => {
  const { environment, sensitive } = scopedEnvironment();
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolspan-cf-checkpoints-"));
  const receiptPath = path.join(directory, `cloudflare-e2e-${SESSION_ID}.json`);
  const snapshots = [];
  const mock = createCloudflareMock({
    beforeMutation: async ({ resource }) => {
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      snapshots.push({ resource, receipt });
    },
  });
  try {
    const result = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "APPLY",
      enableApply: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async ({ expected }) => expected,
    }));
    assert.equal(result.evidence.reason, "SECOND_INVOCATION_REQUIRED");
    assert.deepEqual(
      snapshots.map(({ receipt }) => receipt.apply.checkpoint),
      ["BEFORE_TUNNEL_CREATE", "BEFORE_INGRESS_CONFIGURE", "BEFORE_DNS_CREATE"],
    );
    assert.equal(snapshots[0].receipt.apply.changes.length, 0);
    assert.equal(snapshots[1].receipt.apply.changes.length, 1);
    assert.equal(snapshots[1].receipt.apply.ownedResources.length, 1);
    assert.equal(snapshots[2].receipt.apply.changes.length, 2);
    assert.ok(snapshots.every(({ receipt }) => receipt.secretScan.status === "PASS"));
    assert.ok(snapshots.every(({ receipt }) => !JSON.stringify(receipt).includes(sensitive)));
    const finalReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(finalReceipt.apply.checkpoint, "COMPLETE");
    assert.equal(finalReceipt.apply.changes.length, 3);

    // Simulate a hard process stop after the durable BEFORE checkpoint and an
    // unknown remote outcome. The next invocation may inspect, but not replay
    // or adopt the resources that now exist remotely.
    await writeFile(receiptPath, `${JSON.stringify(snapshots[1].receipt, null, 2)}\n`, "utf8");
    const mutationCount = mock.state.mutations.length;
    const callsBeforeReconcile = mock.state.calls.length;
    const reconcile = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "RECONCILE",
      writeEvidence: true,
      evidenceDirectory: directory,
    }));
    assert.equal(reconcile.evidence.reason, "OUTCOME_UNKNOWN");
    assert.equal(reconcile.evidence.readOnly, true);
    assert.equal(reconcile.evidence.secondRun.status, "FAIL");
    assert.equal(mock.state.mutations.length, mutationCount);
    assert.ok(mock.state.calls.slice(callsBeforeReconcile).every((call) => call.method === "GET"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a receipt-backed second invocation proves idempotency before owned-only cleanup", async () => {
  const { environment, sensitive } = scopedEnvironment();
  const unknownTunnel = {
    id: "22222222-3333-4444-5555-666666666666",
    name: "toolspan-e2e-unknown-untouched",
    status: "inactive",
  };
  const mock = createCloudflareMock({ tunnels: [unknownTunnel] });
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolspan-cf-receipt-"));
  try {
    const apply = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "APPLY",
      enableApply: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async ({ operation, expected }) => {
        assert.equal(operation, "APPLY");
        return expected;
      },
    }));
    assert.equal(apply.evidence.status, "NEEDS_HUMAN_CHECKPOINT");
    assert.equal(apply.evidence.reason, "SECOND_INVOCATION_REQUIRED");
    assert.equal(apply.evidence.apply.status, "APPLIED");
    assert.equal(apply.evidence.secondRun.attempted, false);
    assert.equal(apply.evidence.cleanup.attempted, false);
    assert.equal(mock.state.mutations.length, 3);

    const mutationsBeforeReconcile = mock.state.mutations.length;
    const reconcile = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "RECONCILE",
      cleanupAfterVerify: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async ({ operation, expected, summary }) => {
        assert.equal(operation, "CLEANUP");
        assert.deepEqual(summary.ownedResources, apply.evidence.apply.ownedResources);
        return expected;
      },
    }));
    const reconcileCreates = mock.state.mutations
      .slice(mutationsBeforeReconcile)
      .filter((item) => item.method === "POST" || item.method === "PUT");
    assert.deepEqual(reconcileCreates, []);
    assert.equal(reconcile.evidence.status, "PASS");
    assert.equal(reconcile.evidence.scopeClaim, "API_RESOURCE_LIFECYCLE_ONLY");
    assert.equal(reconcile.evidence.secondRun.status, "PASS");
    assert.equal(reconcile.evidence.secondRun.duplicateCreates, 0);
    assert.equal(reconcile.evidence.secondRun.mutationDelta, 0);
    assert.equal(reconcile.evidence.cleanup.status, "PASS");
    assert.deepEqual(
      reconcile.evidence.cleanup.deletedResources.map((item) => item.id),
      [DNS_ID, TUNNEL_ID],
    );
    assert.deepEqual(mock.state.tunnels, [unknownTunnel]);
    assert.deepEqual(mock.state.dns, []);
    assert.ok(!JSON.stringify(reconcile.evidence).includes(sensitive));
    assert.doesNotThrow(() => validateReconcileReceipt(reconcile.evidence, SESSION_ID));
    for (const invalid of [
      { cleanup: { ...reconcile.evidence.cleanup, attempted: false } },
      { cleanup: { ...reconcile.evidence.cleanup, confirmationStatus: "NOT_REQUESTED" } },
      { cleanup: { ...reconcile.evidence.cleanup, deletedResources: [] } },
      { secondRun: { ...reconcile.evidence.secondRun, status: "NOT_REQUESTED" } },
    ]) {
      assert.throws(
        () => validateReconcileReceipt({ ...reconcile.evidence, ...invalid }, SESSION_ID),
        /RECONCILE_RECEIPT_TERMINAL_STATE_INVALID/u,
      );
    }

    const callsBeforeRepeat = mock.state.calls.length;
    const repeat = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "RECONCILE",
      cleanupAfterVerify: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async () => {
        throw new Error("a completed cleanup must not prompt or mutate again");
      },
    }));
    assert.equal(repeat.evidence.status, "PASS");
    assert.equal(repeat.evidence.cleanup.status, "PASS");
    assert.equal(repeat.evidence.cleanup.checkpoint, "COMPLETE");
    assert.ok(mock.state.calls.slice(callsBeforeRepeat).every((call) => call.method === "GET"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconcile rejects and preserves a receipt that violates the evidence schema", async () => {
  const { environment } = scopedEnvironment();
  const mock = createCloudflareMock();
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolspan-cf-schema-receipt-"));
  try {
    const apply = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "APPLY",
      enableApply: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async ({ expected }) => expected,
    }));
    const receipt = JSON.parse(await readFile(apply.evidencePath, "utf8"));
    receipt.unexpectedDurableField = "must-be-rejected";
    await writeFile(apply.evidencePath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    const callsBefore = mock.state.calls.length;

    const reconcile = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "RECONCILE",
      writeEvidence: true,
      evidenceDirectory: directory,
    }));
    assert.equal(reconcile.evidence.reason, "RECONCILE_RECEIPT_SCHEMA_INVALID");
    assert.equal(reconcile.evidencePath, null);
    assert.equal(mock.state.calls.length, callsBefore);
    assert.equal(JSON.parse(await readFile(apply.evidencePath, "utf8")).unexpectedDurableField, "must-be-rejected");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lost mutating response requires read-only reconcile and is never replayed or adopted", async () => {
  const { environment } = scopedEnvironment();
  const mock = createCloudflareMock({ responseLostOn: "TUNNEL" });
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolspan-cf-unknown-"));
  try {
    const apply = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "APPLY",
      enableApply: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async ({ expected }) => expected,
    }));
    assert.equal(apply.evidence.status, "NEEDS_HUMAN_CHECKPOINT");
    assert.equal(apply.evidence.decision, "RECONCILE_REQUIRED");
    assert.equal(apply.evidence.reason, "OUTCOME_UNKNOWN");
    assert.equal(apply.evidence.apply.status, "OUTCOME_UNKNOWN");
    assert.equal(apply.evidence.apply.checkpoint, "OUTCOME_UNKNOWN");
    assert.equal(mock.state.mutations.length, 1);
    const persisted = JSON.parse(await readFile(apply.evidencePath, "utf8"));
    assert.equal(persisted.apply.status, "OUTCOME_UNKNOWN");

    let prompted = false;
    const callsBeforeReconcile = mock.state.calls.length;
    const reconcile = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "RECONCILE",
      cleanupAfterVerify: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async () => {
        prompted = true;
        throw new Error("unknown ownership must never be confirmed or adopted");
      },
    }));
    assert.equal(reconcile.evidence.reason, "OUTCOME_UNKNOWN");
    assert.equal(reconcile.evidence.readOnly, true);
    assert.equal(reconcile.evidence.secondRun.status, "FAIL");
    assert.equal(reconcile.evidence.secondRun.mutationDelta, 0);
    assert.equal(prompted, false);
    assert.equal(mock.state.mutations.length, 1);
    const reconcileCalls = mock.state.calls.slice(callsBeforeReconcile);
    assert.ok(reconcileCalls.length >= 4);
    assert.ok(reconcileCalls.every((call) => call.method === "GET"));
    assert.ok(reconcileCalls.some((call) => call.url.pathname.endsWith("/zones")));
    assert.ok(reconcileCalls.some((call) => call.url.pathname.endsWith("/dns_records")));
    assert.ok(reconcileCalls.some((call) => call.url.pathname.endsWith("/cfd_tunnel")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a DNS create response with changed proxy semantics is outcome-unknown, never owned", async () => {
  const { environment } = scopedEnvironment();
  const mock = createCloudflareMock({ createdDnsOverrides: { proxied: false } });
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolspan-cf-dns-mismatch-"));
  try {
    const result = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "APPLY",
      enableApply: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async ({ expected }) => expected,
    }));
    assert.equal(result.evidence.reason, "OUTCOME_UNKNOWN");
    assert.equal(result.evidence.apply.status, "OUTCOME_UNKNOWN");
    assert.equal(result.evidence.apply.ownedResources.some((item) => item.kind === "DNS_CNAME"), false);
    assert.equal(result.evidence.secondRun.attempted, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a 2xx PUT without the applied config is outcome-unknown and DNS is never created", async () => {
  const { environment } = scopedEnvironment();
  const mock = createCloudflareMock({ missingTunnelConfigResponse: true });
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolspan-cf-put-shape-"));
  try {
    const result = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "APPLY",
      enableApply: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async ({ expected }) => expected,
    }));
    assert.equal(result.evidence.reason, "OUTCOME_UNKNOWN");
    assert.equal(result.evidence.apply.status, "OUTCOME_UNKNOWN");
    assert.deepEqual(mock.state.mutations.map((item) => item.resource), ["TUNNEL", "TUNNEL_CONFIG"]);
    assert.equal(mock.state.calls.some((call) => call.method === "POST" && call.url.pathname.endsWith("/dns_records")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Cloudflare object key ordering does not change exact config semantics", async () => {
  const { environment } = scopedEnvironment();
  const mock = createCloudflareMock({ reorderedTunnelConfigResponse: true });
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolspan-cf-config-order-"));
  try {
    const result = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "APPLY",
      enableApply: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async ({ expected }) => expected,
    }));
    assert.equal(result.evidence.reason, "SECOND_INVOCATION_REQUIRED");
    assert.equal(result.evidence.apply.status, "APPLIED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Cloudflare disabled server-managed warp routing preserves exact ingress semantics", async () => {
  const { environment } = scopedEnvironment();
  const mock = createCloudflareMock({ warpRoutingEnabled: false });
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolspan-cf-warp-disabled-"));
  try {
    const result = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "APPLY",
      enableApply: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async ({ expected }) => expected,
    }));
    assert.equal(result.evidence.reason, "SECOND_INVOCATION_REQUIRED");
    assert.equal(result.evidence.apply.status, "APPLIED");
    assert.deepEqual(mock.state.mutations.map((item) => item.resource), ["TUNNEL", "TUNNEL_CONFIG", "DNS_CNAME"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Cloudflare enabled warp routing is not accepted as the exact ingress config", async () => {
  const { environment } = scopedEnvironment();
  const mock = createCloudflareMock({ warpRoutingEnabled: true });
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolspan-cf-warp-enabled-"));
  try {
    const result = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "APPLY",
      enableApply: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async ({ expected }) => expected,
    }));
    assert.equal(result.evidence.reason, "OUTCOME_UNKNOWN");
    assert.equal(result.evidence.apply.status, "OUTCOME_UNKNOWN");
    assert.equal(mock.state.calls.some((call) => call.method === "POST" && call.url.pathname.endsWith("/dns_records")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleanup confirmation binds receipt fingerprints and changed ingress stops every delete", async () => {
  const { environment } = scopedEnvironment();
  const mock = createCloudflareMock();
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolspan-cf-cleanup-race-"));
  try {
    const apply = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "APPLY",
      enableApply: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async ({ expected }) => expected,
    }));
    assert.equal(apply.evidence.reason, "SECOND_INVOCATION_REQUIRED");
    const mutationCount = mock.state.mutations.length;

    const reconcile = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "RECONCILE",
      cleanupAfterVerify: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async ({ operation, expected, summary }) => {
        assert.equal(operation, "CLEANUP");
        assert.match(summary.confirmationHash, /^[a-f0-9]{64}$/u);
        assert.notEqual(summary.confirmationHash, apply.evidence.dryRun.planHash);
        assert.ok(expected.includes(summary.confirmationHash));
        assert.deepEqual(summary.ownedResources, apply.evidence.apply.ownedResources);
        assert.deepEqual(summary.expectedIngress, {
          ingress: [
            { hostname: "mcp.aiqushi.top", service: "http://127.0.0.1:8787" },
            { service: "http_status:404" },
          ],
        });
        mock.state.config = { ingress: [{ service: "http_status:503" }] };
        return expected;
      },
    }));
    assert.equal(reconcile.evidence.reason, "OWNED_INGRESS_FINGERPRINT_CHANGED");
    assert.equal(mock.state.mutations.length, mutationCount);
    assert.ok(mock.state.calls.filter((call) => call.method === "DELETE").length === 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleanup re-reads Tunnel identity and ingress after DNS deletion", async () => {
  const { environment } = scopedEnvironment();
  const mock = createCloudflareMock({
    afterDnsDelete: async (state) => {
      state.config = { ingress: [{ service: "http_status:503" }] };
    },
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolspan-cf-delete-race-"));
  try {
    await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "APPLY",
      enableApply: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async ({ expected }) => expected,
    }));
    const result = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "RECONCILE",
      cleanupAfterVerify: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async ({ expected }) => expected,
    }));
    assert.equal(result.evidence.reason, "OWNED_INGRESS_FINGERPRINT_CHANGED");
    assert.equal(mock.state.calls.filter((call) => call.method === "DELETE").length, 1);
    assert.equal(mock.state.tunnels.some((item) => item.id === TUNNEL_ID), true);

    const deletesBeforeFollowup = mock.state.calls.filter((call) => call.method === "DELETE").length;
    const followup = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "RECONCILE",
      cleanupAfterVerify: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async () => {
        throw new Error("partial cleanup must not prompt or replay");
      },
    }));
    assert.equal(followup.evidence.reason, "PARTIAL_CLEANUP_REQUIRES_MANUAL_RECONCILE");
    assert.deepEqual(followup.evidence.cleanup.deletedResources, [{ kind: "DNS_CNAME", id: DNS_ID }]);
    assert.equal(mock.state.calls.filter((call) => call.method === "DELETE").length, deletesBeforeFollowup);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a schema-valid receipt cannot substitute another prefixed tunnel for the session-owned tunnel", async () => {
  const { environment } = scopedEnvironment();
  const substitute = {
    id: "22222222-3333-4444-5555-666666666666",
    name: "toolspan-e2e-substitute",
    status: "inactive",
  };
  const mock = createCloudflareMock({ tunnels: [substitute] });
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolspan-cf-substitution-"));
  try {
    const apply = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "APPLY",
      enableApply: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async ({ expected }) => expected,
    }));
    const receipt = JSON.parse(await readFile(apply.evidencePath, "utf8"));
    const substitutedFingerprint = createHash("sha256").update(JSON.stringify({
      id: substitute.id,
      name: substitute.name,
      accountId: ACCOUNT_ID,
    })).digest("hex");
    const tunnelOwnership = receipt.apply.ownedResources.find((item) => item.kind === "TUNNEL");
    tunnelOwnership.id = substitute.id;
    tunnelOwnership.fingerprint = substitutedFingerprint;
    receipt.apply.changes[0].id = substitute.id;
    receipt.apply.changes[1].id = substitute.id;
    await writeFile(apply.evidencePath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    mock.state.tunnels = [substitute];
    const deletesBefore = mock.state.calls.filter((call) => call.method === "DELETE").length;

    const reconcile = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "RECONCILE",
      cleanupAfterVerify: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async () => {
        throw new Error("substituted ownership must fail before confirmation");
      },
    }));
    assert.equal(reconcile.evidence.reason, "SECOND_RUN_IDEMPOTENCY_FAILED");
    assert.equal(mock.state.calls.filter((call) => call.method === "DELETE").length, deletesBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unknown cleanup outcome remains GET-only even when the resource is still visible", async () => {
  const { environment } = scopedEnvironment();
  const mock = createCloudflareMock({ responseLostOn: "DNS_DELETE_VISIBLE" });
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolspan-cf-cleanup-unknown-"));
  try {
    await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "APPLY",
      enableApply: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async ({ expected }) => expected,
    }));
    const uncertain = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "RECONCILE",
      cleanupAfterVerify: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async ({ expected }) => expected,
    }));
    assert.equal(uncertain.evidence.reason, "OUTCOME_UNKNOWN");
    assert.equal(uncertain.evidence.cleanup.status, "OUTCOME_UNKNOWN");
    assert.equal(mock.state.dns.length, 1);

    const callsBefore = mock.state.calls.length;
    let prompted = false;
    const followup = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "RECONCILE",
      cleanupAfterVerify: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async () => {
        prompted = true;
        throw new Error("an unknown delete must never be replayed");
      },
    }));
    assert.equal(followup.evidence.reason, "OUTCOME_UNKNOWN");
    assert.equal(followup.evidence.readOnly, true);
    assert.equal(prompted, false);
    assert.ok(mock.state.calls.slice(callsBefore).every((call) => call.method === "GET"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ambiguous DNS or Tunnel DELETE responses stop before any subsequent delete", async (context) => {
  const cases = [
    { name: "DNS", options: { dnsDeleteResponse: {} }, expectedDeletes: 1 },
    { name: "Tunnel", options: { tunnelDeleteResponse: { id: "wrong-delete-id" } }, expectedDeletes: 2 },
  ];
  for (const item of cases) {
    await context.test(item.name, async () => {
      const { environment } = scopedEnvironment();
      const mock = createCloudflareMock(item.options);
      const directory = await mkdtemp(path.join(os.tmpdir(), "toolspan-cf-delete-shape-"));
      try {
        await runCloudflareE2E(fixedRunOptions({
          manifest: manifest("SCOPED_API_TOKEN"),
          environment,
          fetch: mock.fetch,
          mode: "APPLY",
          enableApply: true,
          writeEvidence: true,
          evidenceDirectory: directory,
          confirmationChannel: async ({ expected }) => expected,
        }));
        const result = await runCloudflareE2E(fixedRunOptions({
          manifest: manifest("SCOPED_API_TOKEN"),
          environment,
          fetch: mock.fetch,
          mode: "RECONCILE",
          cleanupAfterVerify: true,
          writeEvidence: true,
          evidenceDirectory: directory,
          confirmationChannel: async ({ expected }) => expected,
        }));
        assert.equal(result.evidence.reason, "OUTCOME_UNKNOWN");
        assert.equal(result.evidence.cleanup.status, "OUTCOME_UNKNOWN");
        assert.equal(mock.state.calls.filter((call) => call.method === "DELETE").length, item.expectedDeletes);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("a temporary non-active reconcile observation never corrupts the immutable Apply receipt", async () => {
  const { environment } = scopedEnvironment();
  const mock = createCloudflareMock();
  const directory = await mkdtemp(path.join(os.tmpdir(), "toolspan-cf-zone-recovery-"));
  try {
    await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "APPLY",
      enableApply: true,
      writeEvidence: true,
      evidenceDirectory: directory,
      confirmationChannel: async ({ expected }) => expected,
    }));
    mock.state.zoneStatus = "pending";
    const pending = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "RECONCILE",
      writeEvidence: true,
      evidenceDirectory: directory,
    }));
    assert.equal(pending.evidence.secondRun.status, "FAIL");
    assert.equal(pending.evidence.zone.status, "ACTIVE");
    assert.equal(pending.evidence.reconcileZone.status, "PENDING");

    mock.state.zoneStatus = "active";
    const recovered = await runCloudflareE2E(fixedRunOptions({
      manifest: manifest("SCOPED_API_TOKEN"),
      environment,
      fetch: mock.fetch,
      mode: "RECONCILE",
      writeEvidence: true,
      evidenceDirectory: directory,
    }));
    assert.equal(recovered.evidence.reason, "OWNED_CLEANUP_PENDING");
    assert.equal(recovered.evidence.secondRun.status, "PASS");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the evidence scanner rejects secret-like durable fields and exact value reflection", () => {
  const sensitive = ["unit", "secret", "reflection", "value"].join("-");
  const evidence = {
    credentialType: "SCOPED_API_TOKEN",
    credentialVerified: true,
    accidentalApiToken: sensitive,
  };
  assert.deepEqual(scanSanitizedEvidence(evidence, [sensitive]), {
    status: "FAIL",
    forbiddenFieldCount: 1,
    matchedSecretValues: 1,
  });
});
