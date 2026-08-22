import { beforeEach, describe, expect, it, vi } from "vitest";

import fixture from "../fixtures/desktop-production-results.json";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { createTauriDesktopAdapter, mapRuntimeSnapshot } from "../../src/adapters/tauri-adapter";
import type { SetupSafeManifest } from "../../src/adapters/types";

function success(id: string, result: unknown) {
  return { id, ok: true, result };
}

const setupManifest: SetupSafeManifest = {
  schemaVersion: "1.0",
  toolSpanVersion: "fixture-version",
  instanceName: "Fixture workstation",
  localUrl: "http://127.0.0.1:8787/mcp",
  desiredHostname: "mcp.example.test",
  publicMcpUrl: "https://mcp.example.test/mcp",
  oauthDiscoveryUrl: "https://mcp.example.test/.well-known/oauth-authorization-server",
  expectedToolCount: 27,
  tunnelName: "toolspan-fixture",
  domainChoice: "existing",
  officialDocs: ["https://developers.cloudflare.com/"],
  generatedAt: "2026-08-21T00:00:00.000Z",
};

const setupProtocolSnapshot = {
  setupProtocolVersion: "1",
  setupJournalVersion: "1",
  setupManifestSchemaVersion: "1.0",
  setupReceiptSchemaVersion: "1",
  sessionId: "setup-fixture-001",
  target: { zoneName: "example.test" },
  status: "WAITING_FOR_CONFIRMATION",
  manifest: setupManifest,
  plan: {
    schemaVersion: "1",
    sessionId: "setup-fixture-001",
    account: { id: "account-fixture", name: "Fixture account" },
    zone: { id: "zone-fixture", name: "example.test", status: "active", nameservers: [] },
    actions: [
      { kind: "tunnel", classification: "reused", resourceId: "tunnel-fixture", name: "toolspan-fixture", desiredFingerprint: "sha256:tunnel", reason: "Healthy tunnel already exists." },
      { kind: "dns", classification: "created", name: "mcp.example.test", desiredFingerprint: "sha256:dns", reason: "The hostname is available." },
    ],
    warnings: [],
    confirmationRequired: true,
    plannedAt: "2026-08-21T00:00:01.000Z",
  },
  requiresCredential: false,
  updatedAt: "2026-08-21T00:00:01.000Z",
};

const setupProtocolCompleteSnapshot = {
  ...setupProtocolSnapshot,
  status: "COMPLETE",
  receipt: {
    schemaVersion: "1",
    sessionId: "setup-fixture-001",
    idempotencyKey: "idempotency-fixture-001",
    startedAt: "2026-08-21T00:00:02.000Z",
    completedAt: "2026-08-21T00:00:03.000Z",
    resources: [],
    verification: [
      { check: "tool_contract", passed: true, checkedAt: "2026-08-21T00:00:03.000Z", detail: "Exactly 27 tools." },
    ],
    rollback: { status: "not_started", resources: [] },
    duplicateCreates: 0,
  },
  updatedAt: "2026-08-21T00:00:03.000Z",
};

describe("production Tauri adapter shapes", () => {
  beforeEach(() => {
    mocks.listen.mockResolvedValue(() => undefined);
    mocks.invoke.mockImplementation((command: string, args: { request?: { id: string; method: string }; input?: { credential?: { kind?: string } } }) => {
      if (command === "setup_set_credential") {
        return Promise.resolve({ accepted: true, credentialKind: args.input?.credential?.kind });
      }
      const request = args.request;
      if (request === undefined) return Promise.resolve(undefined);
      const results: Record<string, unknown> = {
        "runtime.getSnapshot": fixture.snapshot,
        "runtime.listJobs": fixture.jobs,
        "runtime.listArtifacts": fixture.artifacts,
        "runtime.getLogChunk": fixture.logs,
        "runtime.cancelJob": { id: "job-complete", status: "cancelled" },
        "connection.testLocal": { target: "local", ok: true, status: 200, latencyMs: 12, service: "toolspan", version: "fixture-version", error: null },
        "connection.testPublic": { target: "public", ok: true, status: "READY", latencyMs: 22, checkedUrl: "https://mcp.example.test/healthz", checkedAt: "2026-01-15T10:02:00.000Z" },
        "setup.getSnapshot": setupProtocolSnapshot,
        "setup.preflight": setupProtocolSnapshot,
        "setup.plan": setupProtocolSnapshot,
        "setup.apply": setupProtocolCompleteSnapshot,
        "setup.rollback": setupProtocolSnapshot,
        "setup.reconcile": setupProtocolSnapshot,
        "setup.discardCredential": { discarded: true, sessionId: "setup-fixture-001" },
      };
      return Promise.resolve(success(request.id, results[request.method]));
    });
  });

  it("maps the flat Host snapshot to the nested renderer model", async () => {
    const adapter = createTauriDesktopAdapter();
    const snapshot = await adapter.getSnapshot();
    expect(snapshot.core).toMatchObject({ state: "running", managedByDesktop: true, version: "fixture-version" });
    expect(snapshot.connection.localUrl).toBe("http://127.0.0.1:8787/mcp");
    expect(snapshot.toolContract).toEqual({ available: 27, total: 27 });
    expect(snapshot.workspaces).toHaveLength(1);
  });

  it("keeps an explicit flat Host mapping for the cross-layer protocol fixture", () => {
    const snapshot = mapRuntimeSnapshot(fixture.hostSnapshot);
    expect(snapshot).toMatchObject({
      core: { state: "running", version: "fixture-version" },
      connection: { localUrl: "http://127.0.0.1:8787/mcp" },
      toolContract: { available: 27, total: 27 },
    });
  });

  it("unwraps jobs/artifacts/log chunks and preserves Core status vocabulary", async () => {
    const adapter = createTauriDesktopAdapter();
    await adapter.getSnapshot();
    await expect(adapter.listJobs()).resolves.toMatchObject([{ status: "completed" }, { status: "timed_out" }]);
    await expect(adapter.listArtifacts()).resolves.toMatchObject([{ name: "result.txt", sizeBytes: 42, publicUrl: "https://mcp.example.test/artifacts/published/fixture-public" }]);
    await expect(adapter.getLogs({ level: "warn" })).resolves.toMatchObject([{ level: "warn", source: "core" }]);
  });

  it("uses protocol jobId and never passes a caller URL to connection tests", async () => {
    const adapter = createTauriDesktopAdapter();
    await adapter.getSnapshot();
    await adapter.cancelJob("job-complete");
    await adapter.testPublic();
    const requests = mocks.invoke.mock.calls.map((call) => call[1]?.request).filter(Boolean);
    expect(requests).toContainEqual(expect.objectContaining({ method: "runtime.cancelJob", params: { jobId: "job-complete" } }));
    const publicRequest = requests.find((request) => request?.method === "connection.testPublic");
    expect(publicRequest?.params).toEqual({});
    expect(JSON.stringify(publicRequest)).not.toMatch(/url|endpoint|baseUrl/iu);
  });

  it("invokes the native Node picker without a renderer-supplied path or arguments", async () => {
    await createTauriDesktopAdapter().chooseNodeExecutable();
    expect(mocks.invoke).toHaveBeenLastCalledWith("choose_node_executable", {});
    expect(JSON.stringify(mocks.invoke.mock.calls.at(-1)?.[1])).not.toMatch(/path|command|args/iu);
  });

  it("maps Setup snapshots and keeps credentials out of all seven setup protocol method parameters", async () => {
    const adapter = createTauriDesktopAdapter();
    const secret = "fixture-secret-only-in-rust-command";
    await adapter.setSetupCredential("setup-fixture-001", { kind: "api_token", token: secret });
    const snapshot = await adapter.setupPreflight(
      "setup-fixture-001",
      "idempotency-fixture-001",
      "example.test",
      setupProtocolSnapshot.manifest,
    );
    expect(snapshot).toMatchObject({
      phase: "WAITING_FOR_CONFIRMATION",
      domain: "example.test",
      zone: { status: "active", accountId: "account-fixture", zoneId: "zone-fixture" },
      plan: { items: [{ disposition: "reused" }, { disposition: "created" }] },
    });
    await adapter.setupPlan("setup-fixture-001");
    await expect(adapter.setupApply("setup-fixture-001")).resolves.toMatchObject({
      phase: "COMPLETE",
      duplicateCreates: 0,
      verificationEvidence: [{ check: "tool_contract", passed: true, detail: "Exactly 27 tools." }],
    });
    await adapter.setupRollback("setup-fixture-001");
    await adapter.setupReconcile("setup-fixture-001");
    await adapter.getSetupSnapshot("setup-fixture-001");
    await adapter.discardSetupCredential("setup-fixture-001");

    const protocolRequests = mocks.invoke.mock.calls
      .filter((call) => call[0] === "desktop_invoke")
      .map((call) => call[1]?.request)
      .filter((request) => request?.method?.startsWith("setup."));
    expect(protocolRequests.map((request) => request?.method)).toEqual([
      "setup.preflight", "setup.plan", "setup.apply", "setup.rollback", "setup.reconcile", "setup.getSnapshot", "setup.discardCredential",
    ]);
    expect(JSON.stringify(protocolRequests)).not.toContain(secret);
    const preflight = protocolRequests[0];
    expect(preflight?.params).toMatchObject({
      sessionId: "setup-fixture-001",
      idempotencyKey: "idempotency-fixture-001",
      zoneName: "example.test",
    });
    expect(preflight?.params?.manifest).not.toHaveProperty("sessionId");
    expect(preflight?.params?.manifest).not.toHaveProperty("idempotencyKey");
    expect(preflight?.params?.manifest).not.toHaveProperty("zoneName");
    expect(protocolRequests.find((request) => request?.method === "setup.apply")?.params).toEqual({ sessionId: "setup-fixture-001", confirmation: "APPLY" });
    expect(protocolRequests.find((request) => request?.method === "setup.rollback")?.params).toEqual({ sessionId: "setup-fixture-001", confirmation: "ROLLBACK" });
  });

  it("preserves the production no-active-session null result for the Renderer IDLE draft", async () => {
    mocks.invoke.mockImplementationOnce((_command: string, args: { request: { id: string } }) => Promise.resolve(success(args.request.id, null)));
    await expect(createTauriDesktopAdapter().getSetupSnapshot()).resolves.toBeNull();
  });

  it("delivers both native tray actions to the renderer and removes both listeners", async () => {
    const handlers = new Map<string, () => void>();
    const removed = new Map<string, ReturnType<typeof vi.fn>>();
    mocks.listen.mockImplementation((event: string, handler: () => void) => {
      handlers.set(event, handler);
      const remove = vi.fn();
      removed.set(event, remove);
      return Promise.resolve(remove);
    });
    const actions: string[] = [];

    const remove = await createTauriDesktopAdapter().onTrayAction((action) => actions.push(action));
    handlers.get("tray://copy-mcp-url")?.();
    handlers.get("tray://open-logs")?.();

    expect(actions).toEqual(["copy-mcp-url", "open-logs"]);
    remove();
    expect(removed.get("tray://copy-mcp-url")).toHaveBeenCalledOnce();
    expect(removed.get("tray://open-logs")).toHaveBeenCalledOnce();
  });
});
