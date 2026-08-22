import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { SERVICE_INFO } from "../src/service-info.js";

describe("service information", () => {
  it("uses the ToolSpan identity and root package metadata", async () => {
    const packageMetadata = JSON.parse(await readFile("package.json", "utf8")) as {
      name: string;
      version: string;
    };

    expect(SERVICE_INFO).toEqual({
      product: "ToolSpan",
      service: "toolspan",
      package: packageMetadata.name,
      version: packageMetadata.version,
    });
  });
});
