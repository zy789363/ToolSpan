import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/styles.css"),
  "utf8",
);
const appShell = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/components/app-shell.tsx"),
  "utf8",
);

describe("desktop shell scrolling", () => {
  it("keeps the sidebar outside the workspace scroll container", () => {
    expect(stylesheet).toMatch(/\.app-frame\s*\{[^}]*height:\s*100vh;[^}]*overflow:\s*hidden/iu);
    expect(stylesheet).toMatch(/\.sidebar\s*\{[^}]*height:\s*100vh;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto/iu);
    expect(stylesheet).toMatch(/\.workspace-frame\s*\{[^}]*min-height:\s*0;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto/iu);
  });

  it("keeps the titlebar visible and reserves its scrollbar gutter", () => {
    expect(stylesheet).toMatch(/\.titlebar\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:/iu);
    expect(stylesheet).toMatch(/\.workspace-frame\s*\{[^}]*scrollbar-gutter:\s*stable/iu);
  });

  it("keeps section headings left-aligned when no meta control is present", () => {
    expect(stylesheet).toMatch(/\.section-title\s*>\s*div\s*\{[^}]*margin-left:\s*auto/iu);
    expect(stylesheet).not.toMatch(/\.section-title\s*>\s*:last-child/iu);
  });

  it("aligns the titlebar content with the centered page content", () => {
    expect(appShell).toMatch(/<div className="titlebar__inner">/u);
    expect(stylesheet).toMatch(/\.titlebar__inner\s*\{[^}]*width:\s*min\(1180px, 100%\);/iu);
  });

  it("allows dense desktop layouts to stack at the supported minimum width", () => {
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*960px\)[\s\S]*\.metrics-grid(?:\s*,[^{}]*)?\s*\{[^}]*grid-template-columns:\s*repeat\(2,/iu);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*960px\)[\s\S]*\.setup-path-grid\s*,\s*\.domain-choice-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/iu);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*960px\)[\s\S]*\.manual-setup-list dl\s*\{[^}]*grid-template-columns:\s*repeat\(2,/iu);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*960px\)[\s\S]*\.page-header\s*\{[^}]*flex-wrap:\s*wrap/iu);
  });
});

describe("public setup layout", () => {
  it("matches the three visible choices and keeps dense setup content readable at minimum width", () => {
    expect(stylesheet).toMatch(/\.setup-path-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,/iu);
    expect(stylesheet).toMatch(/\.domain-choice-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,/iu);
    expect(stylesheet).toMatch(/\.setup-guide-details\s*\{/iu);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*960px\)[\s\S]*\.manual-setup-list\s+dl\s*\{[^}]*repeat\(2,/iu);
  });
});
