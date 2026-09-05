import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createJobService, type JobStatus } from "../src/jobs/job-service.js";
import { JobStore } from "../src/jobs/job-store.js";
import { createWorkspaceService, type WorkspaceService } from "../src/workspaces/workspace-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function waitForFile(filePath: string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return (await readFile(filePath, "utf8")).trim();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForProcessGone(pid: number, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.platform !== "win32") {
      try {
        const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");
        const closingParenthesis = stat.lastIndexOf(")");
        const state = stat.slice(closingParenthesis + 2).trim().split(/\s+/u)[0];
        if (state === undefined || state === "Z") return;
      } catch {
        return;
      }
    } else {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Process ${String(pid)} is still running`);
}

function forceKillProcess(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process may already have exited.
  }
}

describe("background job service", () => {
  it("starts a runner asynchronously and exposes its persisted output through polling", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-jobs-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    const databasePath = path.join(fixtureRoot, "state.sqlite");
    await mkdir(project, { recursive: true });
    const workspaces = await createWorkspaceService({ allowedRoots: [allowedRoot], databasePath });
    const jobs = await createJobService({
      workspaces,
      databasePath,
      jobsDirectory: path.join(fixtureRoot, "jobs"),
      runners: {
        node_eval: {
          executable: process.execPath,
          prefixArgs: ["-e"],
          validateArgs: (args) => args.length === 1,
          maxConcurrent: 1,
          maxTimeoutSeconds: 5,
          maxOutputBytes: 64 * 1024,
        },
      },
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const started = await jobs.startJob({
        workspaceId: workspace.id,
        runner: "node_eval",
        args: ["console.log('job-ok')"],
      });

      expect(started).toEqual(expect.objectContaining({ id: expect.any(String), status: "running" }));
      let status: JobStatus = "running";
      let polled = await jobs.pollJob({ jobId: started.id, cursor: 0 });
      for (let attempt = 0; attempt < 50 && status === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        polled = await jobs.pollJob({ jobId: started.id, cursor: 0 });
        status = polled.job.status;
      }

      expect(polled.job.status).toBe("completed");
      expect(polled.output).toContain("job-ok");
      expect(polled.nextCursor).toBeGreaterThan(0);
    } finally {
      await jobs.close();
      workspaces.close();
    }
  });

  it("reserves runner capacity before asynchronous startup and limits a workspace", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-jobs-concurrency-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    const otherProject = path.join(allowedRoot, "other");
    const databasePath = path.join(fixtureRoot, "state.sqlite");
    await mkdir(project, { recursive: true });
    await mkdir(otherProject, { recursive: true });
    const workspaces = await createWorkspaceService({ allowedRoots: [allowedRoot], databasePath });
    const jobs = await createJobService({
      workspaces,
      databasePath,
      jobsDirectory: path.join(fixtureRoot, "jobs"),
      runners: {
        hold: {
          executable: process.execPath,
          prefixArgs: ["-e"],
          validateArgs: (args) => args.length === 1,
          maxConcurrent: 2,
          maxConcurrentPerWorkspace: 1,
          maxTimeoutSeconds: 5,
          maxOutputBytes: 64 * 1024,
        },
      },
    });

    try {
      const [workspace, otherWorkspace] = await Promise.all([
        workspaces.openWorkspace(project),
        workspaces.openWorkspace(otherProject),
      ]);
      const sameWorkspace = await Promise.allSettled([
        jobs.startJob({
          workspaceId: workspace.id,
          runner: "hold",
          args: ["setTimeout(() => {}, 250)"],
        }),
        jobs.startJob({
          workspaceId: workspace.id,
          runner: "hold",
          args: ["setTimeout(() => {}, 250)"],
        }),
      ]);

      expect(sameWorkspace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = sameWorkspace.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(rejected?.reason).toEqual(expect.objectContaining({
        message: "Runner concurrency limit reached for workspace",
      }));
      await expect(jobs.startJob({
        workspaceId: otherWorkspace.id,
        runner: "hold",
        args: ["setTimeout(() => {}, 250)"],
      })).resolves.toEqual(expect.objectContaining({ workspaceId: otherWorkspace.id }));
    } finally {
      await jobs.close();
      workspaces.close();
    }
  });

  it("waits for an in-flight startup before closing the job service", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-jobs-close-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    const databasePath = path.join(fixtureRoot, "state.sqlite");
    await mkdir(project, { recursive: true });
    const workspaces = await createWorkspaceService({ allowedRoots: [allowedRoot], databasePath });
    const opened = await workspaces.openWorkspace(project);
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const delayingWorkspaces: WorkspaceService = {
      openWorkspace: workspaces.openWorkspace.bind(workspaces),
      listWorkspaces: workspaces.listWorkspaces.bind(workspaces),
      resumeWorkspace: workspaces.resumeWorkspace.bind(workspaces),
      resolveExistingPath: workspaces.resolveExistingPath.bind(workspaces),
      resolveEntryPath: workspaces.resolveEntryPath.bind(workspaces),
      resolvePathForWrite: workspaces.resolvePathForWrite.bind(workspaces),
      resolvePathForCreate: workspaces.resolvePathForCreate.bind(workspaces),
      resolveWorkspaceRoot: async (workspaceId) => {
        await blocked;
        return workspaces.resolveWorkspaceRoot(workspaceId);
      },
      close: workspaces.close.bind(workspaces),
    };
    const jobs = await createJobService({
      workspaces: delayingWorkspaces,
      databasePath,
      jobsDirectory: path.join(fixtureRoot, "jobs"),
      runners: {
        hold: {
          executable: process.execPath,
          prefixArgs: ["-e"],
          validateArgs: (args) => args.length === 1,
          maxConcurrent: 1,
          maxConcurrentPerWorkspace: 1,
          maxTimeoutSeconds: 5,
          maxOutputBytes: 64 * 1024,
        },
      },
    });

    try {
      const pending = jobs.startJob({
        workspaceId: opened.id,
        runner: "hold",
        args: ["setTimeout(() => {}, 100)"],
      });
      await new Promise((resolve) => setImmediate(resolve));
      const closing = jobs.close();
      release?.();
      await expect(pending).rejects.toThrow("Job service is closing");
      await expect(closing).resolves.toBeUndefined();
      await expect(jobs.close()).resolves.toBeUndefined();
      await expect(readdir(path.join(fixtureRoot, "jobs"))).resolves.toEqual([]);
    } finally {
      await jobs.close();
      workspaces.close();
    }
  });

  it("keeps UTF-8 characters intact across poll pages", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-jobs-utf8-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    const databasePath = path.join(fixtureRoot, "state.sqlite");
    await mkdir(project, { recursive: true });
    const workspaces = await createWorkspaceService({ allowedRoots: [allowedRoot], databasePath });
    const jobs = await createJobService({
      workspaces,
      databasePath,
      jobsDirectory: path.join(fixtureRoot, "jobs"),
      runners: {
        output: {
          executable: process.execPath,
          prefixArgs: ["-e"],
          validateArgs: (args) => args.length === 1,
          maxConcurrent: 1,
          maxTimeoutSeconds: 5,
          maxOutputBytes: 128 * 1024,
        },
      },
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const started = await jobs.startJob({
        workspaceId: workspace.id,
        runner: "output",
        args: ["process.stdout.write('a'.repeat(65535) + '😀')"],
      });
      let status: JobStatus = "running";
      for (let attempt = 0; attempt < 40 && status === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        status = (await jobs.pollJob({ jobId: started.id, cursor: 0 })).job.status;
      }
      const first = await jobs.pollJob({ jobId: started.id, cursor: 0 });
      const second = await jobs.pollJob({ jobId: started.id, cursor: first.nextCursor });
      expect(status).toBe("completed");
      expect((first.output + second.output).includes("😀")).toBe(true);
      expect((first.output + second.output).includes("�")).toBe(false);
      expect(second.nextCursor).toBeGreaterThan(first.nextCursor);
    } finally {
      await jobs.close();
      workspaces.close();
    }
  });

  it("cancels a running job and records a terminal cancelled state", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-jobs-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    const databasePath = path.join(fixtureRoot, "state.sqlite");
    await mkdir(project, { recursive: true });
    const workspaces = await createWorkspaceService({ allowedRoots: [allowedRoot], databasePath });
    const jobs = await createJobService({
      workspaces,
      databasePath,
      jobsDirectory: path.join(fixtureRoot, "jobs"),
      runners: {
        node_eval: {
          executable: process.execPath,
          prefixArgs: ["-e"],
          validateArgs: (args) => args.length === 1,
          maxConcurrent: 1,
          maxTimeoutSeconds: 5,
          maxOutputBytes: 64 * 1024,
        },
      },
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const started = await jobs.startJob({
        workspaceId: workspace.id,
        runner: "node_eval",
        args: ["setInterval(() => console.log('waiting'), 100)"],
      });

      await expect(jobs.cancelJob(started.id)).resolves.toEqual(
        expect.objectContaining({ id: started.id, status: "cancelled" }),
      );
      await expect(jobs.pollJob({ jobId: started.id })).resolves.toEqual(
        expect.objectContaining({ job: expect.objectContaining({ status: "cancelled" }) }),
      );
    } finally {
      await jobs.close();
      workspaces.close();
    }
  });

  it("cancels and closes the entire runner process group", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-jobs-grandchild-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    const databasePath = path.join(fixtureRoot, "state.sqlite");
    await mkdir(project, { recursive: true });
    const workspaces = await createWorkspaceService({ allowedRoots: [allowedRoot], databasePath });
    const jobs = await createJobService({
      workspaces,
      databasePath,
      jobsDirectory: path.join(fixtureRoot, "jobs"),
      runners: {
        node_eval: {
          executable: process.execPath,
          prefixArgs: ["-e"],
          validateArgs: (args) => args.length === 1,
          maxConcurrent: 1,
          maxTimeoutSeconds: 5,
          maxOutputBytes: 64 * 1024,
        },
      },
    });
    const grandchildScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    let cancelledGrandchildPid: number | undefined;
    let closedGrandchildPid: number | undefined;

    const runnerScript = (pidFile: string): string => [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("\n");

    try {
      const workspace = await workspaces.openWorkspace(project);
      const cancelled = await jobs.startJob({
        workspaceId: workspace.id,
        runner: "node_eval",
        args: [runnerScript(path.join(fixtureRoot, "cancelled-grandchild.pid"))],
      });
      cancelledGrandchildPid = Number(await waitForFile(path.join(fixtureRoot, "cancelled-grandchild.pid")));
      await expect(jobs.cancelJob(cancelled.id)).resolves.toEqual(
        expect.objectContaining({ id: cancelled.id, status: "cancelled" }),
      );
      await expect(waitForProcessGone(cancelledGrandchildPid)).resolves.toBeUndefined();

      const closed = await jobs.startJob({
        workspaceId: workspace.id,
        runner: "node_eval",
        args: [runnerScript(path.join(fixtureRoot, "closed-grandchild.pid"))],
      });
      closedGrandchildPid = Number(await waitForFile(path.join(fixtureRoot, "closed-grandchild.pid")));
      await expect(jobs.close()).resolves.toBeUndefined();
      await expect(waitForProcessGone(closedGrandchildPid)).resolves.toBeUndefined();
    } finally {
      forceKillProcess(cancelledGrandchildPid);
      forceKillProcess(closedGrandchildPid);
      await jobs.close();
      workspaces.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not leave an untracked POSIX grandchild after the runner parent exits",
    async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-jobs-grandchild-exit-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    const databasePath = path.join(fixtureRoot, "state.sqlite");
    const grandchildPidPath = path.join(fixtureRoot, "grandchild.pid");
    await mkdir(project, { recursive: true });
    const workspaces = await createWorkspaceService({ allowedRoots: [allowedRoot], databasePath });
    const jobs = await createJobService({
      workspaces,
      databasePath,
      jobsDirectory: path.join(fixtureRoot, "jobs"),
      runners: {
        node_eval: {
          executable: process.execPath,
          prefixArgs: ["-e"],
          validateArgs: (args) => args.length === 1,
          maxConcurrent: 1,
          maxTimeoutSeconds: 5,
          maxOutputBytes: 64 * 1024,
        },
      },
    });
    let grandchildPid: number | undefined;
    let cancellation: Promise<unknown> | undefined;

    try {
      const workspace = await workspaces.openWorkspace(project);
      const grandchildScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'inherit' });`,
        `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));`,
        "setTimeout(() => {}, 100);",
      ].join("\n");
      const started = await jobs.startJob({
        workspaceId: workspace.id,
        runner: "node_eval",
        args: [parentScript],
      });
      grandchildPid = Number(await waitForFile(grandchildPidPath));
      await waitForProcessGone(started.pid!);
      cancellation = jobs.cancelJob(started.id);
      const result = await Promise.race([
        cancellation,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1500)),
      ]);
      expect(result).toEqual(expect.objectContaining({ id: started.id, status: "cancelled" }));
      await expect(waitForProcessGone(grandchildPid)).resolves.toBeUndefined();
    } finally {
      forceKillProcess(grandchildPid);
      await cancellation;
      await jobs.close();
      workspaces.close();
    }
  });

  it("persists the process identity together with the running job", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-jobs-identity-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    const databasePath = path.join(fixtureRoot, "state.sqlite");
    await mkdir(project, { recursive: true });
    const workspaces = await createWorkspaceService({ allowedRoots: [allowedRoot], databasePath });
    const insertSpy = vi.spyOn(JobStore.prototype, "insert");
    const jobs = await createJobService({
      workspaces,
      databasePath,
      jobsDirectory: path.join(fixtureRoot, "jobs"),
      runners: {
        node_eval: {
          executable: process.execPath,
          prefixArgs: ["-e"],
          validateArgs: (args) => args.length === 1,
          maxConcurrent: 1,
          maxTimeoutSeconds: 5,
          maxOutputBytes: 64 * 1024,
        },
      },
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const started = await jobs.startJob({
        workspaceId: workspace.id,
        runner: "node_eval",
        args: ["setInterval(() => {}, 1000)"],
      });
      const insertCall = insertSpy.mock.calls.find(([record]) => record.id === started.id);
      expect(insertCall?.[1]).toEqual(expect.any(String));
      const store = new JobStore(databasePath);
      try {
        expect(store.listRecoverableProcesses()).toEqual([
          expect.objectContaining({ id: started.id, pidStartToken: expect.any(String) }),
        ]);
      } finally {
        store.close();
      }
    } finally {
      insertSpy.mockRestore();
      await jobs.close();
      workspaces.close();
    }
  });

  it("terminates a runner that exceeds its configured timeout", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-jobs-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    const databasePath = path.join(fixtureRoot, "state.sqlite");
    await mkdir(project, { recursive: true });
    const workspaces = await createWorkspaceService({ allowedRoots: [allowedRoot], databasePath });
    const jobs = await createJobService({
      workspaces,
      databasePath,
      jobsDirectory: path.join(fixtureRoot, "jobs"),
      runners: {
        node_eval: {
          executable: process.execPath,
          prefixArgs: ["-e"],
          validateArgs: (args) => args.length === 1,
          maxConcurrent: 1,
          maxTimeoutSeconds: 0.05,
          maxOutputBytes: 64 * 1024,
        },
      },
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const started = await jobs.startJob({
        workspaceId: workspace.id,
        runner: "node_eval",
        args: ["setInterval(() => {}, 1000)"],
      });
      let polled = await jobs.pollJob({ jobId: started.id });
      for (let attempt = 0; attempt < 50 && polled.job.status === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        polled = await jobs.pollJob({ jobId: started.id });
      }

      expect(polled.job.status).toBe("timed_out");
      expect(polled.job.error).toBe("Runner timed out");
    } finally {
      await jobs.close();
      workspaces.close();
    }
  });

  it("returns a bounded startup error when a configured executable is unavailable", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-jobs-missing-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    const databasePath = path.join(fixtureRoot, "state.sqlite");
    await mkdir(project, { recursive: true });
    const workspaces = await createWorkspaceService({ allowedRoots: [allowedRoot], databasePath });
    const jobs = await createJobService({
      workspaces,
      databasePath,
      jobsDirectory: path.join(fixtureRoot, "jobs"),
      runners: {
        missing: {
          executable: "webgpt-executable-that-does-not-exist.exe",
          validateArgs: () => true,
          maxConcurrent: 1,
          maxTimeoutSeconds: 1,
          maxOutputBytes: 1024,
        },
      },
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      await expect(jobs.startJob({
        workspaceId: workspace.id,
        runner: "missing",
        args: [],
      })).rejects.toThrow(/failed to start/i);
      await expect(jobs.listJobs()).resolves.toEqual([]);
      await expect(readdir(path.join(fixtureRoot, "jobs"))).resolves.toEqual([]);
    } finally {
      await jobs.close();
      workspaces.close();
    }
  });
});
