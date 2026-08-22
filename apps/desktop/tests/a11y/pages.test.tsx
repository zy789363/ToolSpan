import axe from "axe-core";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createDemoDesktopAdapter, demoSnapshot } from "../../src/adapters/demo-adapter";
import type { DesktopAdapter, PageId } from "../../src/adapters/types";
import { renderApp } from "../render-app";

const pages: PageId[] = ["overview", "setup", "connection", "workspaces", "jobs", "artifacts", "logs", "settings"];

describe("desktop accessibility", () => {
  it.each(pages)("has zero serious or critical axe violations on %s", async (page) => {
    const { container } = await renderApp({ page });
    await screen.findByRole("main");
    if (page === "setup") await screen.findByRole("button", { name: /Scoped API token/iu });
    const result = await axe.run(container, { resultTypes: ["violations"] });
    const blocking = result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
    expect(blocking).toEqual([]);
  });

  it("has zero serious or critical axe violations on first run", async () => {
    const { container } = await renderApp({
      snapshot: { ...structuredClone(demoSnapshot), firstRunRequired: true, instanceName: "", workspaces: [] },
    });
    await screen.findByRole("heading", { name: "Welcome to ToolSpan" });
    const result = await axe.run(container, { resultTypes: ["violations"] });
    const blocking = result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
    expect(blocking).toEqual([]);
  });

  it("has zero serious or critical axe violations on native Node recovery", async () => {
    const base = createDemoDesktopAdapter();
    const adapter: DesktopAdapter = {
      ...base,
      getSnapshot: async () => { throw new Error("Node executable was not discovered"); },
    };
    const { container } = await renderApp({ adapter });
    await screen.findByRole("button", { name: "Choose Node executable" });
    const result = await axe.run(container, { resultTypes: ["violations"] });
    const blocking = result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
    expect(blocking).toEqual([]);
  });
});
