import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readPublicBaseUrl, writePublicBaseUrlAtomically } from "../src/setup/core-config-writer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Core publicBaseUrl writer", () => {
  it("reads a local HTTP origin and atomically writes a public HTTPS origin", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "toolspan-config-writer-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "toolspan.config.json");
    await writeFile(configPath, JSON.stringify({
      host: "127.0.0.1",
      port: 8787,
      publicBaseUrl: "http://127.0.0.1:8787",
      allowedRoots: ["C:\\Projects"],
    }), "utf8");

    await expect(readPublicBaseUrl(configPath)).resolves.toBe("http://127.0.0.1:8787");
    await writePublicBaseUrlAtomically(configPath, "https://mcp.example.test");

    await expect(readPublicBaseUrl(configPath)).resolves.toBe("https://mcp.example.test");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      host: "127.0.0.1",
      port: 8787,
      publicBaseUrl: "https://mcp.example.test",
      allowedRoots: ["C:\\Projects"],
    });
    await expect(readdir(directory)).resolves.toEqual(["toolspan.config.json"]);
  });

  it("rejects non-origin public URLs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "toolspan-config-writer-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "toolspan.config.json");
    await writeFile(configPath, JSON.stringify({ publicBaseUrl: "http://127.0.0.1:8787" }), "utf8");

    await expect(writePublicBaseUrlAtomically(configPath, "https://mcp.example.test/mcp"))
      .rejects.toThrow(/HTTPS origin/u);
  });
});
