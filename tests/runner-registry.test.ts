import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createProductionRunners,
  inspectRunnerAvailability,
} from "../src/jobs/runner-registry.js";
import { createJobService } from "../src/jobs/job-service.js";
import { createWorkspaceService } from "../src/workspaces/workspace-service.js";

describe("production runner registry", () => {
  it("maps the shell compatibility runner to allowlisted read-only git commands", async () => {
    const shell = createProductionRunners().shell;
    expect(shell).toBeDefined();
    expect(shell?.validateArgs(["git", "status", "--short"])).toBe(true);
    expect(shell?.validateArgs(["git", "commit", "-m", "unsafe"])).toBe(false);
    expect(shell?.validateArgs(["git", "branch", "new-branch"])).toBe(false);
    expect(shell?.validateArgs(["git", "diff", "--ext-diff"])).toBe(false);
    expect(await shell?.resolveCommand?.(["git", "status", "--short"], "C:\\project")).toEqual({
      executable: "git",
      args: ["status", "--short"],
    });
  });

  it("runs Windows package-manager CLIs through Node instead of command shims", async () => {
    if (process.platform !== "win32") return;
    const runners = createProductionRunners();
    const npm = await runners.npm?.resolveCommand?.(["test"], process.cwd());
    const pnpm = await runners.pnpm?.resolveCommand?.(["test"], process.cwd());
    const yarn = await runners.yarn?.resolveCommand?.(["test"], process.cwd());

    expect(npm).toMatchObject({ executable: process.execPath });
    expect(npm?.args[0]).toMatch(/npm-cli\.js$/u);
    expect(pnpm).toMatchObject({ executable: process.execPath });
    expect(pnpm?.args[0]).toMatch(/pnpm\.js$/u);
    expect(yarn).toMatchObject({ executable: process.execPath });
    expect(yarn?.args[0]).toMatch(/yarn\.js$/u);
  });

  it("uses the matching npm lifecycle entry point when Node and npm are installed separately", async () => {
    if (process.platform !== "win32") return;
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-npm-resolution-"));
    const originalExecPath = process.execPath;
    const originalNpmExecPath = process.env.npm_execpath;
    const npmCli = path.join(fixtureRoot, "node_modules", "npm", "bin", "npm-cli.js");
    const separateNode = path.join(fixtureRoot, "runtime", "node.exe");
    try {
      await mkdir(path.dirname(npmCli), { recursive: true });
      await writeFile(npmCli, "");
      process.execPath = separateNode;
      process.env.npm_execpath = npmCli;

      expect(await createProductionRunners().npm?.resolveCommand?.(["test"], process.cwd())).toEqual({
        executable: separateNode,
        args: [npmCli, "test"],
      });

      const npxCli = path.join(path.dirname(npmCli), "npx-cli.js");
      await writeFile(npxCli, "");
      process.env.npm_execpath = npxCli;
      expect(await createProductionRunners().npm?.resolveCommand?.(["test"], process.cwd())).toEqual({
        executable: separateNode,
        args: [npmCli, "test"],
      });

      const unrelatedCli = path.join(fixtureRoot, "arbitrary", "npm-cli.js");
      await mkdir(path.dirname(unrelatedCli), { recursive: true });
      await writeFile(unrelatedCli, "");
      process.env.npm_execpath = unrelatedCli;
      await expect(createProductionRunners().npm?.resolveCommand?.(["test"], process.cwd()))
        .rejects.toThrow("npm JavaScript entry point is not available");
    } finally {
      process.execPath = originalExecPath;
      if (originalNpmExecPath === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = originalNpmExecPath;
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("runs an npm lifecycle script with the restricted production environment on Windows", async () => {
    if (process.platform !== "win32") return;
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-npm-runner-"));
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    const databasePath = path.join(fixtureRoot, "state.sqlite");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "package.json"), JSON.stringify({
      name: "webgpt-npm-runner-test",
      version: "1.0.0",
      private: true,
      scripts: { test: "node -e \"console.log('npm-runner-ok')\"" },
    }));
    const workspaces = await createWorkspaceService({ allowedRoots: [allowedRoot], databasePath });
    const npmRunner = createProductionRunners().npm;
    if (npmRunner === undefined) throw new Error("npm runner is unavailable");
    const jobs = await createJobService({
      workspaces,
      databasePath,
      jobsDirectory: path.join(fixtureRoot, "jobs"),
      runners: { npm: npmRunner },
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const started = await jobs.startJob({
        workspaceId: workspace.id,
        runner: "npm",
        args: ["test"],
      });
      let polled = await jobs.pollJob({ jobId: started.id });
      const pollDeadline = Date.now() + (process.env.CI === "true" ? 10_000 : 3_000);
      while (polled.job.status === "running" && Date.now() < pollDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        polled = await jobs.pollJob({ jobId: started.id });
      }

      expect(polled.job.status).toBe("completed");
      expect(polled.output).toContain("npm-runner-ok");
    } finally {
      await jobs.close();
      workspaces.close();
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("provides every runner named by the product contract", () => {
    expect(Object.keys(createProductionRunners()).sort()).toEqual([
      "blender",
      "cargo",
      "dotnet",
      "npm",
      "pnpm",
      "pytest",
      "shell",
      "yarn",
    ]);
  });

  it("prefers a workspace virtual environment for pytest on Windows", async () => {
    if (process.platform !== "win32") return;
    const project = await mkdtemp(path.join(tmpdir(), "webgpt-pytest-runner-"));
    try {
      const scripts = path.join(project, ".venv", "Scripts");
      await mkdir(scripts, { recursive: true });
      const pytest = path.join(scripts, "pytest.exe");
      await writeFile(pytest, "");
      const runner = createProductionRunners().pytest;

      expect(await runner?.resolveCommand?.(["-q"], project)).toEqual({
        executable: pytest,
        args: ["-q"],
      });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("reports executable availability without launching a configured workload", async () => {
    const availability = await inspectRunnerAvailability({
      node: {
        executable: process.execPath,
        validateArgs: () => true,
        maxConcurrent: 1,
        maxTimeoutSeconds: 1,
        maxOutputBytes: 1,
      },
      missing: {
        executable: "webgpt-executable-that-does-not-exist.exe",
        validateArgs: () => true,
        maxConcurrent: 1,
        maxTimeoutSeconds: 1,
        maxOutputBytes: 1,
      },
    });

    expect(availability).toEqual([
      { name: "missing", available: false },
      { name: "node", available: true },
    ]);
  });
});
