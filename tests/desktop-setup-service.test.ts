import { describe, expect, it, vi } from "vitest";

import type { CloudflareCredential } from "../src/setup/cloudflare-adapter.js";
import type { SetupService } from "../src/setup/setup-service.js";
import type { SetupSnapshot } from "../src/setup/types.js";
import { createDesktopSetupService } from "../src/desktop-host/setup-service.js";

const sessionId = "setup-session-001";

function snapshot(status: SetupSnapshot["status"] = "PREFLIGHT"): SetupSnapshot {
  return {
    setupProtocolVersion: "1",
    setupJournalVersion: "1",
    setupManifestSchemaVersion: "1.0",
    setupReceiptSchemaVersion: "1",
    sessionId,
    target: { zoneName: "example.test" },
    status,
    manifest: {
      schemaVersion: "1.0",
      toolSpanVersion: "0.7.1",
      instanceName: "Desktop",
      localUrl: "http://127.0.0.1:8787",
      desiredHostname: "mcp.example.test",
      publicMcpUrl: "https://mcp.example.test/mcp",
      oauthDiscoveryUrl: "https://mcp.example.test/.well-known/oauth-authorization-server",
      expectedToolCount: 27,
      tunnelName: "toolspan-test",
      domainChoice: "existing",
      officialDocs: ["https://developers.cloudflare.com/"],
      generatedAt: "2026-08-21T00:00:00.000Z",
    },
    requiresCredential: false,
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}

function setupService(overrides: Partial<SetupService> = {}): SetupService {
  return {
    snapshot: vi.fn(async () => snapshot()),
    preflight: vi.fn(async () => snapshot()),
    plan: vi.fn(async () => snapshot("WAITING_FOR_CONFIRMATION")),
    apply: vi.fn(async () => snapshot("COMPLETE")),
    rollback: vi.fn(async () => snapshot("ROLLED_BACK")),
    reconcile: vi.fn(async () => snapshot("NEEDS_RECONCILIATION")),
    discard: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("Desktop Setup service bridge", () => {
  it("passes an in-memory credential to preflight without returning it", async () => {
    let received: CloudflareCredential | undefined;
    const engine = setupService({
      preflight: vi.fn(async (input) => {
        received = input.credential;
        return snapshot();
      }),
    });
    const bridge = createDesktopSetupService(engine);
    const params = {
      sessionId,
      idempotencyKey: "idempotency-001",
      zoneName: "example.test",
      manifest: snapshot().manifest,
      credential: { kind: "api_token", token: "fixture-secret-token" } as const,
    };

    const result = await bridge.invoke("setup.preflight", params);

    expect(received).toEqual({ kind: "api_token", token: "fixture-secret-token" });
    expect(params).not.toHaveProperty("credential");
    expect(JSON.stringify(result)).not.toContain("fixture-secret-token");
    expect(result).toMatchObject({ sessionId, status: "PREFLIGHT" });
  });

  it("returns credential re-entry state instead of calling a mutation without a credential", async () => {
    const apply = vi.fn(async (_input: Parameters<SetupService["apply"]>[0]) => ({
      ...snapshot("NEEDS_CREDENTIAL_REENTRY"),
      requiresCredential: true,
      blocker: {
        code: "CREDENTIAL_REENTRY_REQUIRED" as const,
        message: "Credential must be entered again",
      },
    }));
    const bridge = createDesktopSetupService(setupService({ apply }));

    await expect(bridge.invoke("setup.apply", {
      sessionId,
      confirmation: "APPLY",
    })).resolves.toMatchObject({
      sessionId,
      status: "NEEDS_CREDENTIAL_REENTRY",
      requiresCredential: true,
      blocker: { code: "CREDENTIAL_REENTRY_REQUIRED" },
    });
    expect(apply).toHaveBeenCalledWith({ sessionId, confirmation: "APPLY" });
  });

  it("rejects any setup engine response containing a secret field", async () => {
    const bridge = createDesktopSetupService(setupService({
      apply: vi.fn(async () => ({
        ...snapshot("COMPLETE"),
        token: "fixture-secret-token",
      }) as SetupSnapshot),
    }));

    await expect(bridge.invoke("setup.apply", {
      sessionId,
      confirmation: "APPLY",
      credential: { kind: "api_token", token: "fixture-secret-token" },
    })).rejects.toThrow("secret-free contract");
  });

  it("maps credential discard to a non-secret acknowledgement", async () => {
    const discard = vi.fn(async () => undefined);
    const bridge = createDesktopSetupService(setupService({ discard }));
    await expect(bridge.invoke("setup.discardCredential", { sessionId })).resolves.toEqual({
      discarded: true,
      sessionId,
    });
    expect(discard).toHaveBeenCalledWith({ sessionId });
  });
});
