import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createDemoDesktopAdapter, demoSnapshot } from "../../src/adapters/demo-adapter";
import type { DesktopAdapter } from "../../src/adapters/types";
import { renderApp } from "../render-app";

describe("ToolSpan desktop renderer", () => {
  it("recovers an unavailable initial snapshot through the native Node executable picker", async () => {
    const user = userEvent.setup();
    const base = createDemoDesktopAdapter();
    const getSnapshot = vi.fn()
      .mockRejectedValueOnce(new Error("Node executable was not discovered"))
      .mockResolvedValue(demoSnapshot);
    const chooseNodeExecutable = vi.fn(async () => undefined);
    const adapter: DesktopAdapter = { ...base, getSnapshot, chooseNodeExecutable };

    await renderApp({ adapter, language: "zh-CN" });
    expect(await screen.findByRole("heading", { name: "无法获取桌面状态" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "选择 Node 可执行文件" }));

    expect(chooseNodeExecutable).toHaveBeenCalledOnce();
    expect(await screen.findByRole("heading", { name: "Demo workstation" })).toBeTruthy();
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });

  it("keeps snapshot recovery fail-closed when the native Node picker rejects", async () => {
    const user = userEvent.setup();
    const base = createDemoDesktopAdapter();
    const getSnapshot = vi.fn(async () => { throw new Error("Node executable was not discovered"); });
    const chooseNodeExecutable = vi.fn(async () => { throw new Error("Native picker rejected the candidate"); });
    const adapter: DesktopAdapter = { ...base, getSnapshot, chooseNodeExecutable };

    await renderApp({ adapter, language: "zh-CN" });
    await user.click(await screen.findByRole("button", { name: "选择 Node 可执行文件" }));

    await waitFor(() => expect(chooseNodeExecutable).toHaveBeenCalledOnce());
    expect(screen.getByRole("heading", { name: "无法获取桌面状态" })).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("button", { name: "选择 Node 可执行文件" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(getSnapshot).toHaveBeenCalledOnce();
  });

  it("exposes exactly eight navigation destinations and renders their real pages", async () => {
    const user = userEvent.setup();
    await renderApp();
    await screen.findByRole("heading", { name: "Demo workstation" });
    const navigation = screen.getByRole("navigation", { name: "ToolSpan" });
    const destinations = within(navigation).getAllByRole("button");
    expect(destinations.map((button) => button.textContent)).toEqual([
      "Overview", "Setup", "Connection", "Workspaces", "Jobs", "Artifacts", "Logs", "Settings",
    ]);
    for (const page of ["Setup", "Connection", "Workspaces", "Jobs", "Artifacts", "Logs", "Settings"]) {
      await user.click(within(navigation).getByRole("button", { name: page }));
      expect(await screen.findByRole("heading", { level: 1, name: page === "Setup" ? "Setup Center" : page })).toBeTruthy();
    }
  });

  it("does not render arbitrary URL or Cloudflare credential fields on Connection", async () => {
    const { container } = await renderApp({ page: "connection" });
    await screen.findByRole("heading", { name: "Connection" });
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(screen.queryByText(/global api key|scoped api token|api key/iu)).toBeNull();
    expect(screen.getByRole("button", { name: "Test configured public endpoint" }).hasAttribute("disabled")).toBe(true);
  });

  it("clears settings password state on cancel, submit, and navigation without persisting plaintext", async () => {
    const user = userEvent.setup();
    const base = createDemoDesktopAdapter();
    const hashOwnerPassword = vi.fn(async () => "$2b$fixture-hash");
    const updateOwnerPasswordHash = vi.fn(async () => undefined);
    const adapter: DesktopAdapter = { ...base, hashOwnerPassword, updateOwnerPasswordHash };
    await renderApp({ adapter, page: "settings" });
    const password = await screen.findByLabelText("New owner password") as HTMLInputElement;
    const plaintext = "owner-password-local-only";

    await user.type(password, plaintext);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(password.value).toBe("");

    await user.type(password, plaintext);
    await user.click(screen.getByRole("button", { name: "Update password" }));
    await screen.findByText("Owner password updated");
    expect(password.value).toBe("");
    expect(hashOwnerPassword).toHaveBeenCalledWith(plaintext);
    expect(updateOwnerPasswordHash).toHaveBeenCalledWith("$2b$fixture-hash");
    expect(JSON.stringify({ ...globalThis.localStorage })).not.toContain(plaintext);

    await user.type(password, plaintext);
    await user.click(screen.getByRole("button", { name: "Overview" }));
    expect(screen.queryByLabelText("New owner password")).toBeNull();
    expect(JSON.stringify({ ...globalThis.localStorage })).not.toContain(plaintext);
  });

  it("offers only Cancel or Stop Core and quit for a managed Core", async () => {
    const user = userEvent.setup();
    const base = createDemoDesktopAdapter();
    let quitHandler: ((managedCore: boolean) => void) | undefined;
    const confirmQuit = vi.fn(async () => undefined);
    const adapter: DesktopAdapter = {
      ...base,
      async onQuitRequested(handler) {
        quitHandler = handler;
        return () => undefined;
      },
      confirmQuit,
    };
    await renderApp({ adapter });
    await screen.findByRole("heading", { name: "Demo workstation" });
    act(() => quitHandler?.(true));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Keep Core running" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirmQuit).not.toHaveBeenCalled();

    act(() => quitHandler?.(true));
    await user.click(await screen.findByRole("button", { name: "Stop Core and quit" }));
    expect(confirmQuit).toHaveBeenCalledTimes(1);
    expect(confirmQuit).toHaveBeenCalledWith(true);
  });

  it("copies the configured MCP URL when the native tray requests it", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const base = createDemoDesktopAdapter();
    let trayHandler: ((action: "copy-mcp-url" | "open-logs") => void) | undefined;
    const adapter: DesktopAdapter = {
      ...base,
      async onTrayAction(handler) {
        trayHandler = handler;
        return () => undefined;
      },
    };
    await renderApp({ adapter });
    await screen.findByRole("heading", { name: "Demo workstation" });
    await waitFor(() => expect(trayHandler).toBeDefined());

    act(() => trayHandler?.("copy-mcp-url"));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(demoSnapshot.connection.localUrl));
  });

  it("opens the Logs page when the native tray requests it", async () => {
    const base = createDemoDesktopAdapter();
    let trayHandler: ((action: "copy-mcp-url" | "open-logs") => void) | undefined;
    const adapter: DesktopAdapter = {
      ...base,
      async onTrayAction(handler) {
        trayHandler = handler;
        return () => undefined;
      },
    };
    await renderApp({ adapter });
    await screen.findByRole("heading", { name: "Demo workstation" });
    await waitFor(() => expect(trayHandler).toBeDefined());

    act(() => trayHandler?.("open-logs"));

    expect(await screen.findByRole("heading", { level: 1, name: "Logs" })).toBeTruthy();
  });

  it("enters the first-run flow from real snapshot state and clears plaintext before review", async () => {
    const user = userEvent.setup();
    const firstRunSnapshot = {
      ...structuredClone(demoSnapshot),
      firstRunRequired: true,
      instanceName: "",
      workspaces: [],
      ownerPasswordConfigured: false,
    };
    const base = createDemoDesktopAdapter({ snapshot: firstRunSnapshot });
    const hashOwnerPassword = vi.fn(async () => "$2b$fixture-hash");
    const completeFirstRun = vi.fn(async () => undefined);
    const adapter: DesktopAdapter = { ...base, hashOwnerPassword, completeFirstRun };
    await renderApp({ adapter });
    await user.click(await screen.findByRole("button", { name: "Set up this computer" }));

    await user.type(screen.getByLabelText("Instance name"), "Fixture workstation");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Choose folder" }));
    await screen.findByText("Selected folder");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText(firstRunSnapshot.statePath)).toBeTruthy();
    expect(screen.getByText(firstRunSnapshot.logPath)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const plaintext = "first-run-password";
    await user.type(screen.getByLabelText("Owner password"), plaintext);
    await user.type(screen.getByLabelText("Confirm password"), plaintext);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Validate and start" });
    expect(screen.queryByLabelText("Owner password")).toBeNull();
    expect(hashOwnerPassword).toHaveBeenCalledWith(plaintext);
    expect(JSON.stringify({ ...globalThis.localStorage })).not.toContain(plaintext);

    await user.click(screen.getByRole("button", { name: "Validate and start" }));
    await screen.findByRole("heading", { name: "Local connection is ready" });
    expect(completeFirstRun).toHaveBeenCalledWith(expect.objectContaining({
      ownerPasswordHash: "$2b$fixture-hash",
      statePath: firstRunSnapshot.statePath,
      logPath: firstRunSnapshot.logPath,
    }));
    expect(JSON.stringify(completeFirstRun.mock.calls)).not.toContain(plaintext);
  });
});
