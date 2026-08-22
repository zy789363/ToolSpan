import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createJobService, type JobStatus } from "../src/jobs/job-service.js";
import { createWorkspaceService } from "../src/workspaces/workspace-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

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
    } finally {
      await jobs.close();
      workspaces.close();
    }
  });
});
