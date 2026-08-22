import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { hash } from "bcryptjs";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import {
  LEGACY_CONFIG_WARNING_CODE,
  loadConfig,
  resolveConfigPath,
  suggestInstanceName,
  type ConfigResolutionWarning,
} from "../src/config.js";
import { createRuntime } from "../src/runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("runtime configuration", () => {
  it("prefers an explicit --config path over environment variables", () => {
    const cwd = path.resolve("config-resolution-test");

    expect(resolveConfigPath({
      argv: ["--config", "explicit.json"],
      env: {
        TOOLSPAN_CONFIG: "toolspan-env.json",
        WEBGPT_CONFIG: "webgpt-env.json",
      },
      cwd,
    })).toBe(path.join(cwd, "explicit.json"));
  });

  it("prefers TOOLSPAN_CONFIG over the legacy environment variable", () => {
    const cwd = path.resolve("config-resolution-test");

    expect(resolveConfigPath({
      env: {
        TOOLSPAN_CONFIG: "toolspan-env.json",
        WEBGPT_CONFIG: "webgpt-env.json",
      },
      cwd,
    })).toBe(path.join(cwd, "toolspan-env.json"));
  });

  it("supports the legacy environment variable with one path-free stable warning", () => {
    const cwd = path.resolve("config-resolution-test");
    const warnings: ConfigResolutionWarning[] = [];
    const options = {
      env: { WEBGPT_CONFIG: "private-location.json" },
      cwd,
      warn: (warning: ConfigResolutionWarning): void => { warnings.push(warning); },
    };

    expect(resolveConfigPath(options)).toBe(path.join(cwd, "private-location.json"));
    expect(resolveConfigPath(options)).toBe(path.join(cwd, "private-location.json"));
    expect(warnings).toEqual([{
      code: LEGACY_CONFIG_WARNING_CODE,
      message: expect.stringContaining("legacy"),
    }]);
    expect(JSON.stringify(warnings)).not.toContain("private-location.json");
  });

  it("falls back to an existing legacy file before the expected ToolSpan path", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "toolspan-config-resolution-"));
    temporaryDirectories.push(directory);
    const legacyPath = path.join(directory, "webgpt.config.json");
    await writeFile(legacyPath, "{}", "utf8");

    expect(resolveConfigPath({ cwd: directory, env: {} })).toBe(legacyPath);

    await rm(legacyPath);
    expect(resolveConfigPath({ cwd: directory, env: {} })).toBe(
      path.join(directory, "toolspan.config.json"),
    );
  });

  it("resolves paths, persists a preview secret, and assembles the production app", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "webgpt-config-"));
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, "projects"));
    await mkdir(path.join(directory, "secrets"));
    await writeFile(
      path.join(directory, "secrets", "owner.bcrypt"),
      `${await hash("owner-password", 4)}\n`,
      "utf8",
    );
    const configPath = path.join(directory, "webgpt.config.json");
    await writeFile(configPath, JSON.stringify({
      instanceName: "home-build-pc",
      host: "127.0.0.1",
      port: 8787,
      publicBaseUrl: "https://mcp.example.test",
      allowedRoots: ["./projects"],
      stateDirectory: "./state",
      ownerPasswordHashFile: "./secrets/owner.bcrypt",
    }), "utf8");

    const first = await loadConfig(configPath);
    const second = await loadConfig(configPath);
    expect(first.instanceName).toBe("home-build-pc");
    expect(first.allowedRoots).toEqual([await realpath(path.join(directory, "projects"))]);
    expect(first.previewSecret).toHaveLength(32);
    expect(second.previewSecret).toEqual(first.previewSecret);
    expect(await readFile(path.join(directory, "state", "preview-secret.bin"))).toEqual(
      first.previewSecret,
    );

    const runtime = await createRuntime(first);
    try {
      await request(runtime.app).get("/healthz").expect(200);
      await request(runtime.app)
        .get("/.well-known/oauth-protected-resource")
        .expect(200)
        .expect(({ body }) => expect(body.resource).toBe("https://mcp.example.test/mcp"));
    } finally {
      await runtime.close();
    }
  });

  it.each([
    ["empty", ""],
    ["too long", "x".repeat(65)],
    ["forward slash", "home/pc"],
    ["backslash", "home\\pc"],
    ["control character", "home\npc"],
  ])("rejects an %s instanceName", async (_description, instanceName) => {
    const directory = await mkdtemp(path.join(tmpdir(), "toolspan-instance-config-"));
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, "projects"));
    await writeFile(path.join(directory, "owner.bcrypt"), await hash("owner-password", 4));
    const configPath = path.join(directory, "toolspan.config.json");
    await writeFile(configPath, JSON.stringify({
      instanceName,
      publicBaseUrl: "https://mcp.example.test",
      allowedRoots: ["./projects"],
      stateDirectory: "./state",
      ownerPasswordHashFile: "./owner.bcrypt",
    }), "utf8");

    await expect(loadConfig(configPath)).rejects.toThrow(/instanceName/i);
  });

  it("creates a valid bounded instance name suggestion from a hostname", () => {
    expect(suggestInstanceName("owner/build\u0000pc")).toBe("owner-build-pc");
    expect(suggestInstanceName("x".repeat(80))).toBe("x".repeat(64));
  });

  it("rejects non-loopback binding and non-HTTPS public origins", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "webgpt-bad-config-"));
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, "projects"));
    await writeFile(path.join(directory, "owner.bcrypt"), await hash("owner-password", 4));
    const configPath = path.join(directory, "webgpt.config.json");
    await writeFile(configPath, JSON.stringify({
      host: "0.0.0.0",
      port: 8787,
      publicBaseUrl: "http://mcp.example.test",
      allowedRoots: ["./projects"],
      stateDirectory: "./state",
      ownerPasswordHashFile: "./owner.bcrypt",
    }), "utf8");

    await expect(loadConfig(configPath)).rejects.toThrow(/loopback|HTTPS/i);
  });

  it("keeps private state outside every agent-accessible allowed root", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "webgpt-overlap-config-"));
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, "projects"));
    await writeFile(path.join(directory, "owner.bcrypt"), await hash("owner-password", 4));
    const configPath = path.join(directory, "webgpt.config.json");
    await writeFile(configPath, JSON.stringify({
      host: "127.0.0.1",
      port: 8787,
      publicBaseUrl: "https://mcp.example.test",
      allowedRoots: ["./projects"],
      stateDirectory: "./projects/private-state",
      ownerPasswordHashFile: "./owner.bcrypt",
    }), "utf8");

    await expect(loadConfig(configPath)).rejects.toThrow(/state.*allowed root/i);
  });
});
