import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { demoSnapshot } from "../../src/adapters/demo-adapter";
import type { PageId } from "../../src/adapters/types";
import { renderApp } from "../render-app";

const fixtures: Array<{ name: string; page: PageId; heading: string }> = [
  { name: "overview", page: "overview", heading: "Demo workstation" },
  { name: "setup", page: "setup", heading: "Setup Center" },
  { name: "connection", page: "connection", heading: "Connection" },
  { name: "settings", page: "settings", heading: "Settings" },
];

describe("synthetic visual fixtures", () => {
  it.each(fixtures.flatMap((fixture) => (["light", "dark"] as const).map((theme) => ({ ...fixture, theme }))))(
    "$name $theme",
    async ({ page, heading, theme }) => {
      const { container } = await renderApp({ page, theme });
      await screen.findByRole("heading", { level: 1, name: heading });
      if (page === "setup") await screen.findByRole("button", { name: /Scoped API token/iu });
      expect(document.documentElement.dataset.theme).toBe(theme);
      expect({
        fixture: page,
        theme,
        heading: container.querySelector("h1")?.textContent,
        navigation: [...container.querySelectorAll(".nav-item")].map((item) => item.textContent),
        cardCount: container.querySelectorAll(".card").length,
        metricCount: container.querySelectorAll(".metric-card").length,
      }).toMatchSnapshot();
    },
  );

  it.each(["light", "dark"] as const)("first-run %s", async (theme) => {
    const { container } = await renderApp({
      snapshot: { ...structuredClone(demoSnapshot), firstRunRequired: true, instanceName: "", workspaces: [] },
      theme,
    });
    await screen.findByRole("heading", { name: "Welcome to ToolSpan" });
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect({
      fixture: "first-run",
      theme,
      heading: container.querySelector("h1")?.textContent,
      steps: container.querySelector(".onboarding-progress")?.textContent,
      actions: [...container.querySelectorAll("button")].map((button) => button.textContent),
    }).toMatchSnapshot();
  });
});
