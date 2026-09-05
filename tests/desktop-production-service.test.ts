import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { hash } from "bcryptjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDesktopProductionService } from "../src/desktop-host/production-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Port was not assigned");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function createRuntimeFixture(): Promise<{
  directory: string;
  configPath: string;
  config: Record<string, unknown>;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "toolspan-desktop-lifecycle-"));
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, "projects"));
  await mkdir(path.join(directory, "secrets"));
  await writeFile(path.join(directory, "secrets", "owner.bcrypt"), await hash("owner-password", 4));
  const port = await reservePort();
  const configPath = path.join(directory, "toolspan.config.json");
  const config = {
    instanceName: "desktop-test",
    host: "127.0.0.1",
    port,
    publicBaseUrl: `http://127.0.0.1:${String(port)}`,
    allowedRoots: ["./projects"],
    stateDirectory: "./state",
    ownerPasswordHashFile: "./secrets/owner.bcrypt",
  };
  await writeFile(configPath, JSON.stringify(config));
  return { directory, configPath, config };
}

describe("Desktop production service", () => {
  it("routes only the frozen setup methods through the injected setup bridge", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "toolspan-desktop-setup-host-"));
    temporaryDirectories.push(directory);
    const invoke = vi.fn(async () => null);
    const service = createDesktopProductionService({
      configPath: path.join(directory, "missing-config.json"),
      setupService: { invoke },
    });

    try {
      await expect(service.invoke("setup.getSnapshot", {})).resolves.toBeNull();
      expect(invoke).toHaveBeenCalledWith("setup.getSnapshot", {});
    } finally {
      await service.close();
    }
  });

  it("owns a real in-process runtime and exposes only sanitized control-plane data", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "toolspan-desktop-host-"));
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, "projects"));
    await mkdir(path.join(directory, "secrets"));
    await writeFile(path.join(directory, "secrets", "owner.bcrypt"), await hash("owner-password", 4));
    const port = await reservePort();
    const configPath = path.join(directory, "toolspan.config.json");
    await writeFile(configPath, JSON.stringify({
      instanceName: "desktop-test",
      host: "127.0.0.1",
      port,
      publicBaseUrl: `http://127.0.0.1:${String(port)}`,
      allowedRoots: ["./projects"],
      stateDirectory: "./state",
      ownerPasswordHashFile: "./secrets/owner.bcrypt",
    }));
    const service = createDesktopProductionService({ configPath });

    try {
      await expect(service.invoke("setup.getSnapshot", {})).resolves.toBeNull();
      const validation = await service.invoke("runtime.validateConfig", {});
      expect(validation).toMatchObject({ valid: true });
      expect(JSON.stringify(validation)).not.toMatch(/ownerPassword|previewSecret|owner-password/u);

      const running = await service.invoke("runtime.start", {});
      expect(running).toMatchObject({
        state: "running",
        firstRunRequired: false,
        managedByDesktop: true,
        nodeVersion: process.version,
        nodePathConfigured: true,
        ownerPasswordConfigured: true,
        mcpTools: { available: 27, total: 27 },
        workspaces: [{ access: "read-write" }],
      });
      await expect(service.invoke("runtime.listJobs", {})).resolves.toEqual({ jobs: [] });
      await expect(service.invoke("runtime.listArtifacts", {})).resolves.toEqual({ artifacts: [] });
      await expect(service.invoke("connection.testLocal", {})).resolves.toMatchObject({
        target: "local",
        ok: true,
        status: 200,
        service: "toolspan",
      });
      await expect(service.invoke("connection.testPublic", {})).resolves.toMatchObject({
        target: "public",
        ok: false,
        error: "PUBLIC_TARGET_NOT_ALLOWED",
      });

      await writeFile(
        path.join(directory, "state", "webgpt-service.log"),
        "Cloudflare API Key=must-not-leak\nordinary diagnostic\n",
      );
      const logs = await service.invoke("runtime.getLogChunk", {}) as { chunk: string };
      expect(logs.chunk).toContain("ordinary diagnostic");
      expect(logs.chunk).not.toContain("must-not-leak");
      expect((await service.invoke("runtime.stop", {}) as { state: string }).state).toBe("stopped");
    } finally {
      await service.close();
    }
  });

  it("keeps a missing workspace repairable and exposes a persisted safe startup diagnostic", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "toolspan-desktop-invalid-config-"));
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, "state"));
    await mkdir(path.join(directory, "secrets"));
    await writeFile(path.join(directory, "secrets", "owner.bcrypt"), await hash("owner-password", 4));
    const configPath = path.join(directory, "toolspan.config.json");
    const missingRoot = path.join(directory, "missing-project");
    await writeFile(configPath, JSON.stringify({
      instanceName: "desktop-test",
      host: "127.0.0.1",
      port: 8787,
      publicBaseUrl: "http://127.0.0.1:8787",
      allowedRoots: [missingRoot],
      stateDirectory: "./state",
      ownerPasswordHashFile: "./secrets/owner.bcrypt",
    }));
    const logPath = path.join(directory, "logs", "toolspan-service.log");
    const service = createDesktopProductionService({ configPath, logPath });

    try {
      await expect(service.invoke("runtime.start", {})).rejects.toMatchObject({ code: "ENOENT" });
      await expect(service.invoke("runtime.getSnapshot", {})).resolves.toMatchObject({
        state: "attention",
        firstRunRequired: true,
      });
      const logs = await service.invoke("runtime.getLogChunk", {}) as { chunk: string };
      expect(logs.chunk).toContain("CONFIG_INVALID");
      expect(logs.chunk).not.toContain(missingRoot);
      expect(await readFile(logPath, "utf8")).toContain("CONFIG_INVALID");
    } finally {
      await service.close();
    }
  });

  it("serializes concurrent runtime lifecycle requests", async () => {
    const fixture = await createRuntimeFixture();
    const service = createDesktopProductionService({ configPath: fixture.configPath });

    try {
      const started = await Promise.all([
        service.invoke("runtime.start", {}) as Promise<{ state: string }>,
        service.invoke("runtime.start", {}) as Promise<{ state: string }>,
      ]);
      expect(started.map((result) => result.state)).toEqual(["running", "running"]);

      const lifecycle = await Promise.all([
        service.invoke("runtime.stop", {}) as Promise<{ state: string }>,
        service.invoke("runtime.restart", {}) as Promise<{ state: string }>,
      ]);
      expect(lifecycle.map((result) => result.state)).toEqual(["stopped", "running"]);
    } finally {
      await service.close();
    }
  });

  it("loads the current config while a runtime is active", async () => {
    const fixture = await createRuntimeFixture();
    const service = createDesktopProductionService({ configPath: fixture.configPath });

    try {
      await service.invoke("runtime.start", {});
      const updatedPublicBaseUrl = "http://localhost:8787";
      await writeFile(fixture.configPath, JSON.stringify({
        ...fixture.config,
        publicBaseUrl: updatedPublicBaseUrl,
      }));

      await expect(service.invoke("runtime.getConfigSummary", {})).resolves.toMatchObject({
        publicBaseUrl: updatedPublicBaseUrl,
      });
      await expect(service.invoke("runtime.getSnapshot", {})).resolves.toMatchObject({
        publicBaseUrl: updatedPublicBaseUrl,
      });
    } finally {
      await service.close();
    }
  });

  it("does not restart an active runtime for an injected setup service", async () => {
    const fixture = await createRuntimeFixture();
    const invoke = vi.fn(async () => ({ status: "COMPLETE" }));
    const service = createDesktopProductionService({
      configPath: fixture.configPath,
      setupService: { invoke },
    });
    const snapshotStates: string[] = [];
    service.subscribeEvents?.((event) => {
      if (event.event === "runtime.snapshot") {
        snapshotStates.push((event.data as { state: string }).state);
      }
    });

    try {
      await service.invoke("runtime.start", {});
      const beforeSetup = snapshotStates.length;
      await service.invoke("setup.apply", {});
      expect(invoke).toHaveBeenCalledWith("setup.apply", {});
      expect(snapshotStates).toHaveLength(beforeSetup);
    } finally {
      await service.close();
    }
  });
});
