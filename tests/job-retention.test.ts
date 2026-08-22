import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JobStore } from "../src/jobs/job-store.js";
import { createJobService, type JobRecord } from "../src/jobs/job-service.js";
import { createWorkspaceService } from "../src/workspaces/workspace-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("job retention", () => {
  it("prunes the oldest terminal records and returns their log paths", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "webgpt-retention-"));
    temporaryDirectories.push(directory);
    const allowedRoot = path.join(directory, "projects");
    const project = path.join(allowedRoot, "demo");
    const databasePath = path.join(directory, "state.sqlite");
    await mkdir(project, { recursive: true });
    const workspaces = await createWorkspaceService({ allowedRoots: [allowedRoot], databasePath });
    const workspace = await workspaces.openWorkspace(project);
    const store = new JobStore(databasePath);
    try {
      for (let index = 0; index < 3; index += 1) {
        const timestamp = new Date(Date.UTC(2026, 0, index + 1)).toISOString();
        const record: JobRecord = {
          id: `00000000-0000-4000-8000-00000000000${String(index)}`,
          workspaceId: workspace.id,
          runner: "test",
          args: [],
          status: "completed",
          pid: null,
          exitCode: 0,
          error: null,
          logPath: path.join(directory, `${String(index)}.log`),
          createdAt: timestamp,
          startedAt: timestamp,
          finishedAt: timestamp,
        };
        store.insert(record);
      }

      expect(store.pruneTerminal(2)).toEqual([path.join(directory, "0.log")]);
      expect(store.list()).toHaveLength(2);
    } finally {
      store.close();
      workspaces.close();
    }
  });

  it("marks an orphaned nonterminal job interrupted when the service restarts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "webgpt-restart-"));
    temporaryDirectories.push(directory);
    const allowedRoot = path.join(directory, "projects");
    const project = path.join(allowedRoot, "demo");
    const databasePath = path.join(directory, "state.sqlite");
    await mkdir(project, { recursive: true });
    const workspaces = await createWorkspaceService({ allowedRoots: [allowedRoot], databasePath });
    const workspace = await workspaces.openWorkspace(project);
    const timestamp = new Date().toISOString();
    const store = new JobStore(databasePath);
    store.insert({
      id: "00000000-0000-4000-8000-000000000099",
      workspaceId: workspace.id,
      runner: "test",
      args: [],
      status: "running",
      pid: 99999,
      exitCode: null,
      error: null,
      logPath: path.join(directory, "orphan.log"),
      createdAt: timestamp,
      startedAt: timestamp,
      finishedAt: null,
    });
    store.close();

    const jobs = await createJobService({
      workspaces,
      databasePath,
      jobsDirectory: path.join(directory, "jobs"),
      runners: {},
    });
    try {
      await expect(jobs.listJobs()).resolves.toEqual([
        expect.objectContaining({ status: "interrupted", error: "Service restarted" }),
      ]);
    } finally {
      await jobs.close();
      workspaces.close();
    }
  });
});
