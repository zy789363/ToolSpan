import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createSetupService } from "../src/setup/setup-service.js";
import { SetupStore } from "../src/setup/setup-store.js";
import type { CloudflareCredential, CloudflareDnsRecord, CloudflareTunnel } from "../src/setup/cloudflare-adapter.js";
import {
  SetupError,
  type SetupManifestDraft,
  type SetupService as SetupServiceType,
} from "../src/setup/index.js";
import { FakeCloudflareAdapter, FakeCloudflaredAdapter } from "./fixtures/setup/fake-adapters.js";

const temporaryDirectories: string[] = [];
const testCredential = { kind: "api_token" as const, token: "test-management-token" };

function setupManifest(overrides: Partial<SetupManifestDraft> = {}): SetupManifestDraft {
  return {
    toolSpanVersion: "0.7.1",
    instanceName: "Local test",
    localUrl: "http://127.0.0.1:8787",
    desiredHostname: "mcp.example.test",
    publicMcpUrl: "https://mcp.example.test/mcp",
    oauthDiscoveryUrl: "https://mcp.example.test/.well-known/oauth-authorization-server",
    expectedToolCount: 27,
    tunnelName: "toolspan-test",
    domainChoice: "existing",
    officialDocs: ["https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/"],
    ...overrides,
  };
}

async function setupHarness(options: {
  cloudflare?: FakeCloudflareAdapter;
  cloudflared?: FakeCloudflaredAdapter;
  processInspector?: { isAlive(pid: number): boolean };
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "toolspan-setup-"));
  temporaryDirectories.push(directory);
  const cloudflare = options.cloudflare ?? new FakeCloudflareAdapter();
  const cloudflared = options.cloudflared ?? new FakeCloudflaredAdapter();
  const service = createSetupService({
    directory,
    cloudflare,
    cloudflared,
    ...(options.processInspector === undefined ? {} : { processInspector: options.processInspector }),
  });
  return { directory, cloudflare, cloudflared, service };
}

async function preflightSession(
  service: SetupServiceType,
  suffix: string,
  options: {
    credential?: CloudflareCredential;
    manifest?: SetupManifestDraft;
    zoneName?: string;
  } = {},
) {
  return service.preflight({
    sessionId: `session-${suffix}`,
    idempotencyKey: `idempotency-${suffix}`,
    zoneName: options.zoneName ?? "example.test",
    manifest: options.manifest ?? setupManifest(),
    credential: options.credential ?? testCredential,
  });
}

async function completeSession(
  service: SetupServiceType,
  suffix: string,
  credential: CloudflareCredential = testCredential,
) {
  const preflight = await preflightSession(service, suffix, { credential });
  await service.plan({ sessionId: preflight.sessionId });
  return service.apply({ sessionId: preflight.sessionId, confirmation: "APPLY", credential });
}

async function readPersistedTree(directory: string): Promise<string> {
  const contents: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else contents.push(await readFile(candidate, "utf8"));
    }
  };
  await visit(directory);
  return contents.join("\n");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("SetupService", () => {
  it("keeps Dry Run free of external mutations through confirmation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "toolspan-setup-"));
    temporaryDirectories.push(directory);
    const cloudflare = new FakeCloudflareAdapter();
    const cloudflared = new FakeCloudflaredAdapter();
    const service = createSetupService({ directory, cloudflare, cloudflared });
    const credential = { kind: "api_token" as const, token: "test-token-not-a-secret" };

    const preflight = await service.preflight({
      sessionId: "session-dry-run",
      idempotencyKey: "idempotency-dry-run",
      zoneName: "example.test",
      credential,
      manifest: {
        toolSpanVersion: "0.7.1",
        instanceName: "Local test",
        localUrl: "http://127.0.0.1:8787",
        desiredHostname: "mcp.example.test",
        publicMcpUrl: "https://mcp.example.test/mcp",
        oauthDiscoveryUrl: "https://mcp.example.test/.well-known/oauth-authorization-server",
        expectedToolCount: 27,
        tunnelName: "toolspan-test",
        domainChoice: "existing",
        officialDocs: ["https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/"],
      },
    });
    expect(preflight.status).toBe("PREFLIGHT");

    const planned = await service.plan({ sessionId: preflight.sessionId });

    expect(planned.status).toBe("WAITING_FOR_CONFIRMATION");
    expect(planned.plan?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "tunnel", classification: "created" }),
        expect.objectContaining({ kind: "dns", classification: "created" }),
      ]),
    );
    expect(cloudflare.mutationCalls).toEqual([]);
    expect(cloudflared.calls).toEqual(["inspect"]);
  });

  it("requires the exact Apply confirmation before any mutation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "toolspan-setup-"));
    temporaryDirectories.push(directory);
    const cloudflare = new FakeCloudflareAdapter();
    const service = createSetupService({
      directory,
      cloudflare,
      cloudflared: new FakeCloudflaredAdapter(),
    });
    const credential = { kind: "api_token" as const, token: "test-token-not-a-secret" };
    const preflight = await service.preflight({
      sessionId: "session-confirm",
      idempotencyKey: "idempotency-confirm",
      zoneName: "example.test",
      credential,
      manifest: {
        toolSpanVersion: "0.7.1",
        instanceName: "Local test",
        localUrl: "http://127.0.0.1:8787",
        desiredHostname: "mcp.example.test",
        publicMcpUrl: "https://mcp.example.test/mcp",
        oauthDiscoveryUrl: "https://mcp.example.test/.well-known/oauth-authorization-server",
        expectedToolCount: 27,
        tunnelName: "toolspan-test",
        domainChoice: "existing",
        officialDocs: ["https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/"],
      },
    });
    await service.plan({ sessionId: preflight.sessionId });

    await expect(
      service.apply({
        sessionId: preflight.sessionId,
        confirmation: "NO" as "APPLY",
        credential,
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(cloudflare.mutationCalls).toEqual([]);
  });

  it("applies a confirmed plan and records non-secret resource classifications", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "toolspan-setup-"));
    temporaryDirectories.push(directory);
    const cloudflare = new FakeCloudflareAdapter();
    const cloudflared = new FakeCloudflaredAdapter();
    const service = createSetupService({ directory, cloudflare, cloudflared });
    const credential = { kind: "api_token" as const, token: "apply-only-test-token" };
    const preflight = await service.preflight({
      sessionId: "session-apply",
      idempotencyKey: "idempotency-apply",
      zoneName: "example.test",
      credential,
      manifest: {
        toolSpanVersion: "0.7.1",
        instanceName: "Local test",
        localUrl: "http://127.0.0.1:8787",
        desiredHostname: "mcp.example.test",
        publicMcpUrl: "https://mcp.example.test/mcp",
        oauthDiscoveryUrl: "https://mcp.example.test/.well-known/oauth-authorization-server",
        expectedToolCount: 27,
        tunnelName: "toolspan-test",
        domainChoice: "existing",
        officialDocs: ["https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/"],
      },
    });
    await service.plan({ sessionId: preflight.sessionId });

    const completed = await service.apply({
      sessionId: preflight.sessionId,
      confirmation: "APPLY",
      credential,
    });

    expect(completed.status).toBe("COMPLETE");
    expect(cloudflare.mutationCalls).toEqual([
      "createTunnel",
      "updateTunnelConfig",
      "createDnsRecord",
    ]);
    expect(cloudflared.calls).toEqual(["inspect", "install", "verify"]);
    expect(completed.receipt).toEqual(
      expect.objectContaining({
        duplicateCreates: 0,
        resources: expect.arrayContaining([
          expect.objectContaining({ kind: "tunnel", classification: "created", ownedBySession: true }),
          expect.objectContaining({ kind: "dns", classification: "created", ownedBySession: true }),
          expect.objectContaining({ kind: "cloudflared", classification: "created", ownedBySession: true }),
        ]),
      }),
    );
  });

  it("stops planning when the Cloudflare zone is missing", async () => {
    const harness = await setupHarness();
    harness.cloudflare.zones = [];
    const preflight = await preflightSession(harness.service, "zone-missing");

    await expect(harness.service.plan({ sessionId: preflight.sessionId })).rejects.toMatchObject({
      code: "ZONE_NOT_FOUND",
    });
    expect((await harness.service.snapshot({ sessionId: preflight.sessionId }))?.blocker?.code).toBe("ZONE_NOT_FOUND");
    expect(harness.cloudflare.mutationCalls).toEqual([]);
  });

  it("stops planning for a pending zone and returns assigned nameservers", async () => {
    const harness = await setupHarness();
    harness.cloudflare.zones[0]!.status = "pending";
    const preflight = await preflightSession(harness.service, "zone-pending");

    await expect(harness.service.plan({ sessionId: preflight.sessionId })).rejects.toMatchObject({
      code: "ZONE_PENDING",
    });
    expect((await harness.service.snapshot({ sessionId: preflight.sessionId }))?.blocker?.nameservers).toEqual([
      "alice.ns.cloudflare.com",
      "bob.ns.cloudflare.com",
    ]);
    expect(harness.cloudflare.mutationCalls).toEqual([]);
  });

  it("rejects unbounded client session identifiers before creating state", async () => {
    const harness = await setupHarness();
    await expect(
      harness.service.preflight({
        sessionId: "../bad",
        idempotencyKey: "valid-idempotency",
        zoneName: "example.test",
        manifest: setupManifest(),
        credential: testCredential,
      }),
    ).rejects.toThrow("sessionId must contain 8-128");
    expect(await harness.service.snapshot()).toBeUndefined();
  });

  it("rejects duplicate client session IDs without rebinding credentials", async () => {
    const harness = await setupHarness();
    await preflightSession(harness.service, "duplicate-session");
    await expect(preflightSession(harness.service, "duplicate-session")).rejects.toThrow("already exists");
    expect(harness.cloudflare.calls.filter((call) => call === "verifyCredential")).toHaveLength(1);
  });

  it("preserves the exact 27 Tool Contract in Safe Manifest validation", async () => {
    const harness = await setupHarness();
    await expect(
      preflightSession(harness.service, "tool-contract", {
        manifest: setupManifest({ expectedToolCount: 26 as 27 }),
      }),
    ).rejects.toThrow("exact 27 Tool Contract");
    expect(harness.cloudflare.calls).toEqual([]);
  });

  it("rejects a non-loopback local Core URL", async () => {
    const harness = await setupHarness();
    await expect(
      preflightSession(harness.service, "local-url", {
        manifest: setupManifest({ localUrl: "http://192.0.2.10:8787" }),
      }),
    ).rejects.toThrow("HTTP loopback URL");
  });

  it("does not infer a zone and rejects hostnames outside the explicit target", async () => {
    const harness = await setupHarness();
    await expect(
      preflightSession(harness.service, "zone-boundary", {
        zoneName: "example.test",
        manifest: setupManifest({
          desiredHostname: "mcp.other.test",
          publicMcpUrl: "https://mcp.other.test/mcp",
          oauthDiscoveryUrl: "https://mcp.other.test/.well-known/oauth-authorization-server",
        }),
      }),
    ).rejects.toThrow("selected zone");
  });

  it("rejects non-official URLs from the Safe Manifest", async () => {
    const harness = await setupHarness();
    await expect(
      preflightSession(harness.service, "untrusted-doc", {
        manifest: setupManifest({ officialDocs: ["https://attacker.example/setup"] }),
      }),
    ).rejects.toThrow("official Cloudflare or OpenAI");
    expect(harness.cloudflare.calls).toEqual([]);
  });

  it("recovers a preflight after restart only after credential re-entry", async () => {
    const harness = await setupHarness();
    const preflight = await preflightSession(harness.service, "restart-preflight");
    const restarted = createSetupService({
      directory: harness.directory,
      cloudflare: harness.cloudflare,
      cloudflared: harness.cloudflared,
    });

    expect((await restarted.snapshot({ sessionId: preflight.sessionId }))?.status).toBe("NEEDS_CREDENTIAL_REENTRY");
    expect((await restarted.reconcile({ sessionId: preflight.sessionId }))?.requiresCredential).toBe(true);
    expect((await restarted.reconcile({ sessionId: preflight.sessionId, credential: testCredential })).status).toBe("PREFLIGHT");
    await expect(restarted.plan({ sessionId: preflight.sessionId })).resolves.toMatchObject({
      status: "WAITING_FOR_CONFIRMATION",
    });
  });

  it("returns a credential re-entry snapshot instead of throwing from Apply", async () => {
    const harness = await setupHarness();
    const preflight = await preflightSession(harness.service, "apply-reentry");
    await harness.service.plan({ sessionId: preflight.sessionId });

    const needsCredential = await harness.service.apply({
      sessionId: preflight.sessionId,
      confirmation: "APPLY",
    });
    expect(needsCredential).toMatchObject({ status: "NEEDS_CREDENTIAL_REENTRY", requiresCredential: true });
    expect(harness.cloudflare.mutationCalls).toEqual([]);
    expect((await harness.service.reconcile({ sessionId: preflight.sessionId, credential: testCredential })).status).toBe("WAITING_FOR_CONFIRMATION");
    await expect(
      harness.service.apply({ sessionId: preflight.sessionId, confirmation: "APPLY", credential: testCredential }),
    ).resolves.toMatchObject({ status: "COMPLETE" });
  });

  it("persists zero management and runtime credential values", async () => {
    const harness = await setupHarness();
    harness.cloudflare.runtimeCredential = "runtime-credential-never-persist";
    const credential = { kind: "api_token" as const, token: "management-credential-never-persist" };
    await completeSession(harness.service, "secret-zero", credential);

    const persisted = await readPersistedTree(harness.directory);
    expect(persisted).not.toContain(credential.token);
    expect(persisted).not.toContain(harness.cloudflare.runtimeCredential);
    expect(persisted).not.toMatch(/"(?:credential|token|apiKey|key|password|ownerHash)"\s*:/u);
  });

  it("redacts both management and runtime credentials from failed Apply state", async () => {
    const harness = await setupHarness();
    const management = "management-token-in-error";
    const runtime = "runtime-token-in-error";
    harness.cloudflare.runtimeCredential = runtime;
    harness.cloudflared.failures.set("install", new Error(`install failed ${management} ${runtime}`));
    const credential = { kind: "api_token" as const, token: management };
    const preflight = await preflightSession(harness.service, "secret-error", { credential });
    await harness.service.plan({ sessionId: preflight.sessionId });

    await expect(
      harness.service.apply({ sessionId: preflight.sessionId, confirmation: "APPLY", credential }),
    ).rejects.toThrow("[REDACTED]");
    const persisted = await readPersistedTree(harness.directory);
    expect(persisted).not.toContain(management);
    expect(persisted).not.toContain(runtime);
    expect((await harness.service.snapshot({ sessionId: preflight.sessionId }))?.status).toBe("NEEDS_RECONCILIATION");
  });

  it("creates zero duplicate resources on a second idempotent run", async () => {
    const harness = await setupHarness();
    await completeSession(harness.service, "idempotent-first");
    const mutationsAfterFirst = [...harness.cloudflare.mutationCalls];
    harness.cloudflare.tunnels[0]!.ownedByToolSpan = undefined;
    harness.cloudflare.tunnels[0]!.ownershipKey = undefined;
    harness.cloudflare.dnsRecords[0]!.ownedByToolSpan = undefined;
    harness.cloudflare.dnsRecords[0]!.ownershipKey = undefined;
    const second = await preflightSession(harness.service, "idempotent-second");
    const secondPlan = await harness.service.plan({ sessionId: second.sessionId });
    expect(secondPlan.plan?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "tunnel", classification: "reused" }),
        expect.objectContaining({ kind: "dns", classification: "reused" }),
      ]),
    );
    const completed = await harness.service.apply({
      sessionId: second.sessionId,
      confirmation: "APPLY",
      credential: testCredential,
    });
    expect(harness.cloudflare.mutationCalls).toEqual(mutationsAfterFirst);
    expect(completed.receipt?.duplicateCreates).toBe(0);
  });

  it("stops on a same-name tunnel without ownership proof", async () => {
    const harness = await setupHarness();
    harness.cloudflare.tunnels = [{
      id: "external-tunnel",
      accountId: "account-1",
      name: "toolspan-test",
      status: "healthy",
    }];
    const preflight = await preflightSession(harness.service, "tunnel-conflict");
    await expect(harness.service.plan({ sessionId: preflight.sessionId })).rejects.toMatchObject({
      code: "TUNNEL_CONFLICT",
    });
    expect(harness.cloudflare.mutationCalls).toEqual([]);
  });

  it("stops on an unknown DNS record instead of overwriting it", async () => {
    const harness = await setupHarness();
    harness.cloudflare.dnsRecords = [{
      id: "external-dns",
      zoneId: "zone-1",
      type: "CNAME",
      name: "mcp.example.test",
      content: "other.example.test",
      proxied: false,
      ttl: 300,
    }];
    const preflight = await preflightSession(harness.service, "dns-conflict");
    await expect(harness.service.plan({ sessionId: preflight.sessionId })).rejects.toMatchObject({
      code: "DNS_CONFLICT",
    });
    expect(harness.cloudflare.mutationCalls).toEqual([]);
  });

  it("classifies healthy matching resources as reused or untouched", async () => {
    const harness = await setupHarness();
    const tunnel: CloudflareTunnel = {
      id: "tunnel-existing",
      accountId: "account-1",
      name: "toolspan-test",
      status: "healthy",
      ownedByToolSpan: true,
    };
    harness.cloudflare.tunnels = [tunnel];
    harness.cloudflare.tunnelConfigs.set(tunnel.id, {
      ingress: [
        { hostname: "mcp.example.test", service: "http://127.0.0.1:8787" },
        { service: "http_status:404" },
      ],
    });
    harness.cloudflare.dnsRecords = [{
      id: "dns-existing",
      zoneId: "zone-1",
      type: "CNAME",
      name: "mcp.example.test",
      content: "tunnel-existing.cfargotunnel.com",
      proxied: true,
      ttl: 1,
      ownedByToolSpan: true,
    }];
    harness.cloudflared.status = {
      installed: true,
      serviceInstalled: true,
      serviceId: "service-existing",
      serviceFingerprint: "service-existing-fingerprint",
      ownedBySession: false,
    };
    const preflight = await preflightSession(harness.service, "healthy-reuse");
    const planned = await harness.service.plan({ sessionId: preflight.sessionId });
    expect(planned.plan?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "tunnel", classification: "reused" }),
        expect.objectContaining({ kind: "tunnel_config", classification: "untouched" }),
        expect.objectContaining({ kind: "dns", classification: "reused" }),
        expect.objectContaining({ kind: "zone", classification: "untouched" }),
      ]),
    );
  });

  it("updates only ToolSpan-owned drifted tunnel config and DNS", async () => {
    const harness = await setupHarness();
    harness.cloudflare.tunnels = [{
      id: "tunnel-owned",
      accountId: "account-1",
      name: "toolspan-test",
      status: "healthy",
      ownedByToolSpan: true,
    }];
    harness.cloudflare.tunnelConfigs.set("tunnel-owned", { ingress: [{ service: "http_status:503" }] });
    harness.cloudflare.dnsRecords = [{
      id: "dns-owned",
      zoneId: "zone-1",
      type: "CNAME",
      name: "mcp.example.test",
      content: "old.cfargotunnel.com",
      proxied: true,
      ttl: 1,
      ownedByToolSpan: true,
    }];
    harness.cloudflared.status = {
      installed: true,
      serviceInstalled: true,
      serviceId: "service-existing",
      serviceFingerprint: "service-existing-fingerprint",
      ownedBySession: false,
    };
    const preflight = await preflightSession(harness.service, "owned-update");
    const plan = await harness.service.plan({ sessionId: preflight.sessionId });
    expect(plan.plan?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tunnel_config", classification: "updated" }),
      expect.objectContaining({ kind: "dns", classification: "updated" }),
    ]));
    await expect(
      harness.service.apply({ sessionId: preflight.sessionId, confirmation: "APPLY", credential: testCredential }),
    ).resolves.toMatchObject({ status: "COMPLETE" });
    expect(harness.cloudflare.mutationCalls).toEqual(["updateTunnelConfig", "updateOwnedDnsRecord"]);
  });

  it("enters reconciliation when verification fails after remote changes", async () => {
    const harness = await setupHarness();
    harness.cloudflare.healthy = false;
    const preflight = await preflightSession(harness.service, "verify-failure");
    await harness.service.plan({ sessionId: preflight.sessionId });
    await expect(
      harness.service.apply({ sessionId: preflight.sessionId, confirmation: "APPLY", credential: testCredential }),
    ).rejects.toThrow("verification failed");
    expect((await harness.service.snapshot({ sessionId: preflight.sessionId }))?.status).toBe("NEEDS_RECONCILIATION");
  });

  it("reconciles a crash-like post-Apply verification failure without remote writes", async () => {
    const harness = await setupHarness();
    harness.cloudflared.healthy = false;
    const preflight = await preflightSession(harness.service, "crash-reconcile");
    await harness.service.plan({ sessionId: preflight.sessionId });
    await expect(
      harness.service.apply({ sessionId: preflight.sessionId, confirmation: "APPLY", credential: testCredential }),
    ).rejects.toThrow("verification failed");
    const mutationsBeforeReconcile = [...harness.cloudflare.mutationCalls];
    harness.cloudflared.healthy = true;
    const reconciled = await harness.service.reconcile({ sessionId: preflight.sessionId, credential: testCredential });
    expect(reconciled.status).toBe("COMPLETE");
    expect(harness.cloudflare.mutationCalls).toEqual(mutationsBeforeReconcile);
  });

  it("performs a full owned-only rollback", async () => {
    const harness = await setupHarness();
    const completed = await completeSession(harness.service, "rollback-full");
    const rolledBack = await harness.service.rollback({
      sessionId: completed.sessionId,
      confirmation: "ROLLBACK",
      credential: testCredential,
    });
    expect(rolledBack.status).toBe("ROLLED_BACK");
    expect(rolledBack.receipt?.rollback.status).toBe("full");
    expect(harness.cloudflare.tunnels).toEqual([]);
    expect(harness.cloudflare.dnsRecords).toEqual([]);
    expect(harness.cloudflared.calls).toContain("uninstallOwnedService");
  });

  it("returns partial rollback when a fingerprint changes", async () => {
    const harness = await setupHarness();
    const completed = await completeSession(harness.service, "rollback-partial");
    harness.cloudflare.dnsRecords[0]!.content = "changed-after-apply.example.test";
    const rolledBack = await harness.service.rollback({
      sessionId: completed.sessionId,
      confirmation: "ROLLBACK",
      credential: testCredential,
    });
    expect(rolledBack.status).toBe("ROLLBACK_PARTIAL");
    expect(rolledBack.receipt?.rollback.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "dns", outcome: "failed", reason: expect.stringContaining("fingerprint") }),
    ]));
    expect(harness.cloudflare.dnsRecords).toHaveLength(1);
  });

  it("never uninstalls a reused external cloudflared service", async () => {
    const harness = await setupHarness();
    harness.cloudflared.status = {
      installed: true,
      serviceInstalled: true,
      serviceId: "external-service",
      serviceFingerprint: "external-fingerprint",
      ownedBySession: false,
    };
    const completed = await completeSession(harness.service, "external-service");
    await harness.service.rollback({
      sessionId: completed.sessionId,
      confirmation: "ROLLBACK",
      credential: testCredential,
    });
    expect(harness.cloudflared.calls).not.toContain("uninstallOwnedService");
    expect(harness.cloudflared.status.serviceId).toBe("external-service");
  });

  it("enforces one active APPLYING or ROLLING_BACK lock", async () => {
    const harness = await setupHarness();
    const preflight = await preflightSession(harness.service, "concurrent-lock");
    await harness.service.plan({ sessionId: preflight.sessionId });
    const store = new SetupStore(harness.directory);
    await store.acquireLock({
      schemaVersion: "1",
      sessionId: "other-session",
      status: "APPLYING",
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    });
    await expect(
      harness.service.apply({ sessionId: preflight.sessionId, confirmation: "APPLY", credential: testCredential }),
    ).rejects.toMatchObject({ code: "ACTIVE_SESSION" });
    expect(harness.cloudflare.mutationCalls).toEqual([]);
    await store.releaseLock("other-session");
  });

  it("recovers a stale PID lock only after proving the process is absent", async () => {
    const harness = await setupHarness();
    const preflight = await preflightSession(harness.service, "stale-lock");
    await harness.service.plan({ sessionId: preflight.sessionId });
    const store = new SetupStore(harness.directory);
    const state = await store.readState();
    state.sessions[preflight.sessionId]!.status = "APPLYING";
    await store.writeState(state);
    await store.acquireLock({
      schemaVersion: "1",
      sessionId: preflight.sessionId,
      status: "APPLYING",
      pid: 999_999,
      acquiredAt: new Date().toISOString(),
    });
    const restarted = createSetupService({
      directory: harness.directory,
      cloudflare: harness.cloudflare,
      cloudflared: harness.cloudflared,
      processInspector: { isAlive: () => false },
    });
    const recovered = await restarted.snapshot({ sessionId: preflight.sessionId });
    expect(recovered).toMatchObject({ status: "NEEDS_CREDENTIAL_REENTRY", requiresCredential: true });
    expect(await store.readLock()).toBeUndefined();
  });

  it("discards only the in-memory credential while preserving recovery artifacts", async () => {
    const harness = await setupHarness();
    const preflight = await preflightSession(harness.service, "discard-session");
    await harness.service.discard({ sessionId: preflight.sessionId });
    expect(await harness.service.snapshot({ sessionId: preflight.sessionId })).toMatchObject({
      sessionId: preflight.sessionId,
      status: "NEEDS_CREDENTIAL_REENTRY",
      requiresCredential: true,
    });
    expect(await readPersistedTree(harness.directory)).toContain(preflight.sessionId);
  });

  it.each([
    ["invalid scoped token", "INVALID_CREDENTIAL" as const],
    ["insufficient scoped token", "INSUFFICIENT_CREDENTIAL" as const],
  ])("reports %s without creating a Setup session", async (_scenario, code) => {
    const harness = await setupHarness();
    harness.cloudflare.failures.set(
      "verifyCredential",
      new SetupError({ code, message: `Fake credential failure: ${code}` }),
    );

    await expect(preflightSession(harness.service, `credential-${code.toLowerCase()}`)).rejects.toMatchObject({ code });
    expect(await harness.service.snapshot()).toBeUndefined();
    expect(harness.cloudflare.mutationCalls).toEqual([]);
  });

  it("walks paginated accounts to locate a zone in a later account", async () => {
    const harness = await setupHarness();
    const first = { id: "account-first", name: "First" };
    const second = { id: "account-second", name: "Second" };
    harness.cloudflare.listAccounts = async ({ page = 1 }) => ({
      items: page === 1 ? [first] : [second],
      page,
      totalPages: 2,
    });
    harness.cloudflare.listZones = async ({ accountId, name, page = 1 }) => ({
      items: accountId === second.id && name === "example.test"
        ? [{
            id: "zone-second",
            accountId: second.id,
            name: "example.test",
            status: "active",
            nameservers: [],
          }]
        : [],
      page,
      totalPages: 1,
    });
    const preflight = await preflightSession(harness.service, "pagination-account");
    const planned = await harness.service.plan({ sessionId: preflight.sessionId });
    expect(planned.plan?.account).toEqual(second);
    expect(planned.plan?.zone.id).toBe("zone-second");
  });

  it("stops when the same target zone is ambiguous across multiple accounts", async () => {
    const harness = await setupHarness();
    harness.cloudflare.accounts = [
      { id: "account-one", name: "One" },
      { id: "account-two", name: "Two" },
    ];
    harness.cloudflare.zones = [
      { id: "zone-one", accountId: "account-one", name: "example.test", status: "active", nameservers: [] },
      { id: "zone-two", accountId: "account-two", name: "example.test", status: "active", nameservers: [] },
    ];
    const preflight = await preflightSession(harness.service, "multiple-zones");
    await expect(harness.service.plan({ sessionId: preflight.sessionId })).rejects.toThrow("ambiguous");
    expect(harness.cloudflare.mutationCalls).toEqual([]);
  });

  it("journals an ingress update failure for reconciliation", async () => {
    const harness = await setupHarness();
    const preflight = await preflightSession(harness.service, "ingress-failure");
    await harness.service.plan({ sessionId: preflight.sessionId });
    harness.cloudflare.failures.set("updateTunnelConfig", new Error("fake ingress failure"));
    await expect(
      harness.service.apply({ sessionId: preflight.sessionId, confirmation: "APPLY", credential: testCredential }),
    ).rejects.toThrow("fake ingress failure");
    expect((await harness.service.snapshot({ sessionId: preflight.sessionId }))?.status).toBe("NEEDS_RECONCILIATION");
    expect(harness.cloudflare.mutationCalls).toEqual(["createTunnel"]);
  });

  it("journals tunnel runtime credential retrieval failure without installing a service", async () => {
    const harness = await setupHarness();
    const preflight = await preflightSession(harness.service, "runtime-credential-failure");
    await harness.service.plan({ sessionId: preflight.sessionId });
    harness.cloudflare.failures.set("getTunnelRuntimeCredential", new Error("fake runtime credential failure"));
    await expect(
      harness.service.apply({ sessionId: preflight.sessionId, confirmation: "APPLY", credential: testCredential }),
    ).rejects.toThrow("fake runtime credential failure");
    expect(harness.cloudflared.calls).not.toContain("install");
    expect((await harness.service.snapshot({ sessionId: preflight.sessionId }))?.status).toBe("NEEDS_RECONCILIATION");
  });

  it("surfaces a UAC/service checkpoint without claiming cloudflared installed", async () => {
    const harness = await setupHarness();
    const checkpoint = Object.assign(new Error("MANUAL_OR_UAC_REQUIRED"), {
      code: "MANUAL_OR_UAC_REQUIRED",
    });
    harness.cloudflared.failures.set("install", checkpoint);
    const preflight = await preflightSession(harness.service, "uac-service-failure");
    await harness.service.plan({ sessionId: preflight.sessionId });
    await expect(
      harness.service.apply({ sessionId: preflight.sessionId, confirmation: "APPLY", credential: testCredential }),
    ).rejects.toThrow("MANUAL_OR_UAC_REQUIRED");
    expect(harness.cloudflared.status).toEqual({ installed: false, serviceInstalled: false });
    expect((await harness.service.snapshot({ sessionId: preflight.sessionId }))?.status).toBe("NEEDS_RECONCILIATION");
  });

  it("records DNS/TLS verification timeout without retrying remote creates", async () => {
    const harness = await setupHarness();
    const preflight = await preflightSession(harness.service, "dns-tls-timeout");
    await harness.service.plan({ sessionId: preflight.sessionId });
    harness.cloudflare.failures.set("verifyTunnelHealth", new Error("DNS/TLS verification timeout"));
    await expect(
      harness.service.apply({ sessionId: preflight.sessionId, confirmation: "APPLY", credential: testCredential }),
    ).rejects.toThrow("DNS/TLS verification timeout");
    expect(harness.cloudflare.mutationCalls.filter((call) => call === "createTunnel")).toHaveLength(1);
    expect(harness.cloudflare.mutationCalls.filter((call) => call === "createDnsRecord")).toHaveLength(1);
    expect((await harness.service.snapshot({ sessionId: preflight.sessionId }))?.status).toBe("NEEDS_RECONCILIATION");
  });
});
