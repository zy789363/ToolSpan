import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createDemoDesktopAdapter, demoSetupSnapshot } from "../../src/adapters/demo-adapter";
import type { DesktopAdapter, SetupSnapshot } from "../../src/adapters/types";
import { chatGptSetupContent, commercialSetupContent } from "../../src/lib/setup-content";
import { renderApp } from "../render-app";

function plannedSnapshot(overrides: Partial<SetupSnapshot> = {}): SetupSnapshot {
  return {
    ...structuredClone(demoSetupSnapshot),
    phase: "WAITING_FOR_CONFIRMATION",
    path: "scoped_api_token",
    plan: {
      sideEffectsApplied: false,
      warnings: [],
      items: [
        { id: "created", resource: "DNS record", disposition: "created", summary: "Create a missing record." },
        { id: "reused", resource: "Named tunnel", disposition: "reused", summary: "Reuse a healthy tunnel." },
        { id: "updated", resource: "Ingress", disposition: "updated", summary: "Update owned ingress." },
        { id: "untouched", resource: "External service", disposition: "untouched", summary: "Leave it unchanged." },
      ],
    },
    ...overrides,
  };
}

describe("Setup Center", () => {
  it("renders a local IDLE draft when production has no setup session instead of loading forever", async () => {
    const base = createDemoDesktopAdapter();
    const adapter: DesktopAdapter = { ...base, getSetupSnapshot: vi.fn(async () => null) };
    await renderApp({ adapter, page: "setup" });
    expect(await screen.findByRole("heading", { level: 1, name: "Setup Center" })).toBeTruthy();
    expect(await screen.findByText("IDLE")).toBeTruthy();
    expect(await screen.findByLabelText("Cloudflare zone domain")).toBeTruthy();
    expect(screen.queryByText("Loading current state…")).toBeNull();
  });

  it("keeps the no-referral path and manual/agent paths visible after referral removal", async () => {
    const user = userEvent.setup();
    const { container } = await renderApp({ page: "setup" });
    await screen.findByRole("heading", { level: 1, name: "Setup Center" });

    for (const [index, name] of ["Guided manual", "Scoped API token", "Agent-assisted"].entries()) {
      const query = { name: new RegExp(name, "iu") };
      expect(index === 0 ? await screen.findByRole("button", query) : screen.getByRole("button", query)).toBeTruthy();
    }
    expect(screen.queryByRole("link", { name: /NameSilo — Support ToolSpan/iu })).toBeNull();
    const noReferral = screen.getByRole("link", { name: /NameSilo — No referral/iu });
    expect(noReferral.getAttribute("href")).not.toContain("rid=");
    await user.click(noReferral);
    expect(screen.queryByText(/affiliate-only coupon toolspan/iu)).toBeNull();
    expect(screen.getByText(/text-only NameSilo card/iu)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Guided manual/iu }));
    expect(await screen.findByRole("heading", { name: "Guided manual tutorial" })).toBeTruthy();
    expect(container.querySelectorAll(".manual-setup-list > li")).toHaveLength(9);

    await user.click(screen.getByRole("button", { name: /Agent-assisted/iu }));
    expect(await screen.findByRole("heading", { name: "Agent Prompt Pack" })).toBeTruthy();
    const manifest = container.querySelector(".setup-manifest-preview")?.textContent ?? "";
    expect(manifest).toContain('"expectedToolCount": 27');
    expect(manifest).not.toMatch(/sessionId|idempotencyKey|token|password|statePath|logPath/iu);
    expect(container.querySelectorAll(".setup-checkpoints .badge")).toHaveLength(6);
  });

  it("hides offer claims and dated UI paths when versioned snapshots are stale", () => {
    const staleAt = new Date("2026-10-15T00:00:00.000Z");
    expect(commercialSetupContent(staleAt)).toMatchObject({ current: false, example: null, coupon: null });
    expect(chatGptSetupContent(staleAt)).toMatchObject({ current: false, connectionUrl: null, developerModePath: [] });
  });

  it("records manual ChatGPT completion as USER_CONFIRMED rather than VALIDATED", async () => {
    const user = userEvent.setup();
    await renderApp({ page: "setup" });
    await user.click(await screen.findByRole("button", { name: "I completed the manual host steps" }));
    expect(screen.getByText("User confirmed")).toBeTruthy();
    expect(screen.getByText(/VALIDATED requires real Host evidence/iu)).toBeTruthy();
    expect(screen.queryByText("Validated by real host evidence")).toBeNull();
  });

  it("clears masked credentials on submit, cancel, and navigation without putting a secret in preflight or browser storage", async () => {
    const user = userEvent.setup();
    const base = createDemoDesktopAdapter();
    const setSetupCredential = vi.fn(base.setSetupCredential);
    const setupPreflight = vi.fn(base.setupPreflight);
    const discardSetupCredential = vi.fn(base.discardSetupCredential);
    const adapter: DesktopAdapter = { ...base, setSetupCredential, setupPreflight, discardSetupCredential };
    await renderApp({ adapter, page: "setup" });

    const secret = "fixture-scoped-token-never-persist";
    let token = await screen.findByLabelText("Scoped API token") as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(screen.getByText(/There is no Remember option/iu)).toBeTruthy();
    await user.type(token, secret);
    await user.click(screen.getByRole("button", { name: "Overview" }));
    expect(screen.queryByLabelText("Scoped API token")).toBeNull();
    expect(JSON.stringify({ ...globalThis.localStorage })).not.toContain(secret);
    await user.click(screen.getByRole("button", { name: "Setup" }));
    token = await screen.findByLabelText("Scoped API token") as HTMLInputElement;
    expect(token.value).toBe("");

    await user.type(token, secret);
    await user.click(screen.getByRole("button", { name: "Cancel and discard credential" }));
    expect(token.value).toBe("");
    expect(discardSetupCredential).toHaveBeenCalled();

    await user.type(token, secret);
    await user.click(screen.getByRole("button", { name: "Verify credential and run preflight" }));

    await waitFor(() => expect(setupPreflight).toHaveBeenCalledTimes(1));
    expect(token.value).toBe("");
    expect(setSetupCredential).toHaveBeenCalledWith(expect.any(String), { kind: "api_token", token: secret });
    const [sessionId, idempotencyKey, zoneName, manifest] = setupPreflight.mock.calls[0] ?? [];
    expect(sessionId).toEqual(setSetupCredential.mock.calls[0]?.[0]);
    expect(idempotencyKey).toEqual(expect.any(String));
    expect(zoneName).toBe("example.test");
    expect(JSON.stringify(manifest)).not.toContain(secret);
    expect(JSON.stringify(manifest)).not.toMatch(/sessionId|idempotencyKey/iu);
    expect(Object.keys(manifest ?? {}).sort()).toEqual([
      "desiredHostname", "domainChoice", "expectedToolCount", "generatedAt", "instanceName", "localUrl",
      "oauthDiscoveryUrl", "officialDocs", "publicMcpUrl", "schemaVersion", "toolSpanVersion", "tunnelName",
    ]);
    expect(manifest?.schemaVersion).toBe("1.0");
    expect(JSON.stringify({ ...globalThis.localStorage })).not.toContain(secret);

    expect(screen.queryByLabelText("Scoped API token")).toBeNull();
    expect(JSON.stringify({ ...globalThis.localStorage })).not.toContain(secret);
  });

  it("stops Apply while the Zone is pending and shows assigned nameserver guidance", async () => {
    const setupSnapshot = plannedSnapshot({
      zone: {
        exists: true,
        status: "pending",
        accountId: "account-fixture",
        zoneId: "zone-fixture",
        assignedNameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
      },
    });
    await renderApp({ adapter: createDemoDesktopAdapter({ setupSnapshot }), page: "setup" });
    await screen.findByRole("heading", { name: "Cloudflare Zone gate" });
    expect(screen.getByText("ada.ns.cloudflare.com")).toBeTruthy();
    expect(screen.getByText("bob.ns.cloudflare.com")).toBeTruthy();
    expect(screen.getByText(/Apply is stopped/iu)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply confirmed plan" }).hasAttribute("disabled")).toBe(true);
  });

  it("refreshes the persisted Zone blocker after plan fails instead of losing nameserver evidence", async () => {
    const user = userEvent.setup();
    const pending = plannedSnapshot({
      phase: "PREFLIGHT",
      plan: null,
      zone: {
        exists: true,
        status: "pending",
        accountId: null,
        zoneId: null,
        assignedNameservers: ["pending-one.ns.cloudflare.com", "pending-two.ns.cloudflare.com"],
      },
    });
    const base = createDemoDesktopAdapter();
    const getSetupSnapshot = vi.fn()
      .mockResolvedValueOnce(structuredClone(demoSetupSnapshot))
      .mockResolvedValue(structuredClone(pending));
    const adapter: DesktopAdapter = {
      ...base,
      getSetupSnapshot,
      setupPlan: vi.fn(async () => { throw new Error("sanitized fixture failure"); }),
    };
    await renderApp({ adapter, page: "setup" });
    await user.type(await screen.findByLabelText("Scoped API token"), "fixture-token");
    await user.click(screen.getByRole("button", { name: "Verify credential and run preflight" }));
    const generate = await screen.findByRole("button", { name: "Generate Dry Run" });
    await waitFor(() => expect((generate as HTMLButtonElement).disabled).toBe(false));
    await user.click(generate);
    expect(await screen.findByText("pending-one.ns.cloudflare.com")).toBeTruthy();
    expect(screen.getByText(/Apply is stopped/iu)).toBeTruthy();
    expect(getSetupSnapshot).toHaveBeenCalledTimes(2);
  });

  it("shows partial rollback evidence and leaves terminal cleanup to explicit manual steps", async () => {
    const setupSnapshot = plannedSnapshot({
      phase: "ROLLBACK_PARTIAL",
      rollback: {
        status: "partial",
        remainingResources: ["reused tunnel fixture-tunnel"],
        manualSteps: ["Inspect the external tunnel in Cloudflare."],
      },
    });
    await renderApp({ adapter: createDemoDesktopAdapter({ setupSnapshot }), page: "setup" });

    expect(await screen.findByText("Rollback partial")).toBeTruthy();
    expect(screen.getByText("reused tunnel fixture-tunnel")).toBeTruthy();
    expect(screen.getByText("Inspect the external tunnel in Cloudflare.")).toBeTruthy();
    expect(screen.queryByLabelText("Scoped API token")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconcile remote state" })).toBeNull();
  });

  it("requires fresh session credentials before remote reconciliation", async () => {
    const user = userEvent.setup();
    const setupSnapshot = plannedSnapshot({
      phase: "NEEDS_CREDENTIAL_REENTRY",
      requiresCredential: true,
      rollback: null,
    });
    const base = createDemoDesktopAdapter({ setupSnapshot });
    const setSetupCredential = vi.fn(base.setSetupCredential);
    const setupReconcile = vi.fn(base.setupReconcile);
    const adapter: DesktopAdapter = { ...base, setSetupCredential, setupReconcile };
    await renderApp({ adapter, page: "setup" });
    const token = await screen.findByLabelText("Scoped API token") as HTMLInputElement;
    await user.type(token, "fixture-reentry-token");
    await user.click(screen.getByRole("button", { name: "Reconcile remote state" }));
    await waitFor(() => expect(setupReconcile).toHaveBeenCalledTimes(1));
    expect(setSetupCredential).toHaveBeenCalledWith(expect.any(String), { kind: "api_token", token: "fixture-reentry-token" });
    expect(JSON.stringify({ ...globalThis.localStorage })).not.toContain("fixture-reentry-token");
  });
});
