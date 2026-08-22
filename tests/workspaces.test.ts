import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createWorkspaceService } from "../src/workspaces/workspace-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("workspace service", () => {
  it("opens an allowed project once and lists it by a stable id", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-workspaces-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    await mkdir(project, { recursive: true });
    const service = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });

    try {
      const first = await service.openWorkspace(project);
      const second = await service.openWorkspace(project);

      expect(second.id).toBe(first.id);
      expect(await service.listWorkspaces()).toEqual([
        expect.objectContaining({ id: first.id, path: first.path, status: "active" }),
      ]);
    } finally {
      service.close();
    }
  });

  it("resumes a workspace from SQLite after a service restart", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-workspaces-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "persisted");
    const databasePath = path.join(fixtureRoot, "state.sqlite");
    await mkdir(project, { recursive: true });
    const firstService = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath,
    });
    const opened = await firstService.openWorkspace(project);
    firstService.close();

    const restartedService = await createWorkspaceService({ allowedRoots: [allowedRoot], databasePath });
    try {
      await expect(restartedService.resumeWorkspace(opened.id)).resolves.toEqual(
        expect.objectContaining({ id: opened.id, path: opened.path, status: "active" }),
      );
    } finally {
      restartedService.close();
    }
  });
});
