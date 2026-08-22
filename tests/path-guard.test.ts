import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPathGuard } from "../src/security/path-guard.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "webgpt-path-guard-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("workspace path guard", () => {
  it("opens existing directories under an allowed root and rejects outsiders", async () => {
    const fixtureRoot = await makeTemporaryDirectory();
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const project = path.join(allowedRoot, "project");
    const outside = path.join(fixtureRoot, "outside");
    await mkdir(project, { recursive: true });
    await mkdir(outside);

    const guard = await createPathGuard([allowedRoot]);

    await expect(guard.openWorkspace(project)).resolves.toBe(await realpath(project));
    await expect(guard.openWorkspace(outside)).rejects.toThrow(
      "Workspace is outside allowed roots",
    );
  });

  it("rejects an existing path reached through parent traversal", async () => {
    const fixtureRoot = await makeTemporaryDirectory();
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const project = path.join(allowedRoot, "project");
    const outside = path.join(allowedRoot, "outside.txt");
    await mkdir(project, { recursive: true });
    await writeFile(outside, "secret");
    const guard = await createPathGuard([allowedRoot]);
    const workspace = await guard.openWorkspace(project);

    await expect(guard.resolveExisting(workspace, "../outside.txt")).rejects.toThrow(
      "Path escapes workspace",
    );
  });

  it("rejects a workspace junction that resolves outside the workspace", async () => {
    const fixtureRoot = await makeTemporaryDirectory();
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const project = path.join(allowedRoot, "project");
    const outside = path.join(fixtureRoot, "outside");
    await mkdir(project, { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(project, "escape"), "junction");
    const guard = await createPathGuard([allowedRoot]);
    const workspace = await guard.openWorkspace(project);

    await expect(guard.resolveExisting(workspace, "escape/secret.txt")).rejects.toThrow(
      "Path escapes workspace",
    );
  });

  it("resolves a new file only when its existing parent is inside the workspace", async () => {
    const fixtureRoot = await makeTemporaryDirectory();
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const project = path.join(allowedRoot, "project");
    const source = path.join(project, "src");
    await mkdir(source, { recursive: true });
    const guard = await createPathGuard([allowedRoot]);
    const workspace = await guard.openWorkspace(project);

    await expect(guard.resolveForWrite(workspace, "src/new.ts")).resolves.toBe(
      path.join(await realpath(source), "new.ts"),
    );
  });

  it("resolves nested create paths from the nearest existing safe ancestor", async () => {
    const fixtureRoot = await makeTemporaryDirectory();
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const project = path.join(allowedRoot, "project");
    await mkdir(project, { recursive: true });
    const guard = await createPathGuard([allowedRoot]);
    const workspace = await guard.openWorkspace(project);

    await expect(guard.resolveForCreate(workspace, "new/deep/path")).resolves.toBe(
      path.join(await realpath(project), "new", "deep", "path"),
    );
  });

  it("rejects drive-relative, ADS, and reserved Windows path forms", async () => {
    const fixtureRoot = await makeTemporaryDirectory();
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const project = path.join(allowedRoot, "project");
    await mkdir(project, { recursive: true });
    const guard = await createPathGuard([allowedRoot]);
    const workspace = await guard.openWorkspace(project);

    await expect(guard.resolveForCreate(workspace, "C:relative.txt")).rejects.toThrow();
    await expect(guard.resolveForCreate(workspace, "file.txt:stream")).rejects.toThrow();
    await expect(guard.resolveForCreate(workspace, "CON.txt")).rejects.toThrow();
  });

  it("can resolve a link entry itself while content resolution still rejects escape", async () => {
    const fixtureRoot = await makeTemporaryDirectory();
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const project = path.join(allowedRoot, "project");
    const outside = path.join(allowedRoot, "outside");
    await mkdir(project, { recursive: true });
    await mkdir(outside);
    const linkPath = path.join(project, "outside-link");
    await symlink(outside, linkPath, "junction");
    const guard = await createPathGuard([allowedRoot]);
    const workspace = await guard.openWorkspace(project);

    await expect(guard.resolveEntry(workspace, "outside-link")).resolves.toBe(
      path.join(await realpath(project), "outside-link"),
    );
    await expect(guard.resolveExisting(workspace, "outside-link")).rejects.toThrow(
      "Path escapes workspace",
    );
  });
});
