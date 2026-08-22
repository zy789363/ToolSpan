import { describe, expect, it } from "vitest";

import { createAppI18n } from "../../src/i18n";
import { en, zhCN } from "../../src/i18n/resources";

function keys(value: object, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    return typeof child === "object" && child !== null ? keys(child, path) : [path];
  });
}

describe("desktop translations", () => {
  it("keeps en and zh-CN at exactly the same key set", () => {
    expect(keys(zhCN).sort()).toEqual(keys(en).sort());
  });

  it.each(["en", "zh-CN"] as const)("has zero missing keys in %s", async (language) => {
    const i18n = await createAppI18n(language);
    const missing = keys(en).filter((key) => !i18n.exists(key, { lng: language }));
    expect(missing).toEqual([]);
  });
});
