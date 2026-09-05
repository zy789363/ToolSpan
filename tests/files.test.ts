import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFileService } from "../src/files/file-service.js";
import { createWorkspaceService, type WorkspaceService } from "../src/workspaces/workspace-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("workspace file service", () => {
  it("reads a bounded page of UTF-8 lines from an opened workspace", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-files-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "notes.txt"), "zero\none\ntwo\n", "utf8");
    const workspaces = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const files = createFileService(workspaces, {
        recoveryDirectory: path.join(fixtureRoot, "trash"),
      });

      await expect(
        files.read({ workspaceId: workspace.id, path: "notes.txt", offset: 1, limit: 2 }),
      ).resolves.toEqual({
        path: "notes.txt",
        offset: 1,
        lines: ["one", "two"],
        nextOffset: 3,
        totalLines: 4,
      });
    } finally {
      workspaces.close();
    }
  });

  it("atomically creates or replaces a UTF-8 file inside the workspace", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-files-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    await mkdir(path.join(project, "src"), { recursive: true });
    const workspaces = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const files = createFileService(workspaces, {
        recoveryDirectory: path.join(fixtureRoot, "trash"),
      });

      await expect(
        files.write({ workspaceId: workspace.id, path: "src/value.txt", content: "first" }),
      ).resolves.toEqual({ path: "src/value.txt", bytesWritten: 5 });
      await files.write({ workspaceId: workspace.id, path: "src/value.txt", content: "second" });
      await expect(readFile(path.join(project, "src/value.txt"), "utf8")).resolves.toBe("second");
    } finally {
      workspaces.close();
    }
  });

  it("edits a file only when the old text occurs exactly once", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-files-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "app.ts"), "const oldValue = 1;\n", "utf8");
    const workspaces = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const files = createFileService(workspaces, {
        recoveryDirectory: path.join(fixtureRoot, "trash"),
      });

      await expect(
        files.edit({
          workspaceId: workspace.id,
          path: "app.ts",
          oldText: "oldValue",
          newText: "newValue",
        }),
      ).resolves.toEqual({ path: "app.ts", replacements: 1 });
      await expect(readFile(path.join(project, "app.ts"), "utf8")).resolves.toBe(
        "const newValue = 1;\n",
      );
    } finally {
      workspaces.close();
    }
  });

  it("leaves a file unchanged when edit text is ambiguous", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-files-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    await mkdir(project, { recursive: true });
    const original = "same\nsame\n";
    await writeFile(path.join(project, "ambiguous.txt"), original, "utf8");
    const workspaces = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const files = createFileService(workspaces, {
        recoveryDirectory: path.join(fixtureRoot, "trash"),
      });

      await expect(
        files.edit({
          workspaceId: workspace.id,
          path: "ambiguous.txt",
          oldText: "same",
          newText: "changed",
        }),
      ).rejects.toThrow("oldText must occur exactly once; found 2");
      await expect(readFile(path.join(project, "ambiguous.txt"), "utf8")).resolves.toBe(original);
    } finally {
      workspaces.close();
    }
  });

  it("rejects an edit before reading a file larger than 1 MiB", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-files-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    await mkdir(project, { recursive: true });
    const content = `${"x".repeat(1024 * 1024)}\nneedle\n`;
    await writeFile(path.join(project, "large.txt"), content, "utf8");
    const workspaces = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const files = createFileService(workspaces, {
        recoveryDirectory: path.join(fixtureRoot, "trash"),
      });

      await expect(files.edit({
        workspaceId: workspace.id,
        path: "large.txt",
        oldText: "needle",
        newText: "changed",
      })).rejects.toThrow("File exceeds the 1 MiB read limit");
      await expect(readFile(path.join(project, "large.txt"), "utf8")).resolves.toBe(content);
    } finally {
      workspaces.close();
    }
  });

  it("searches file content with ripgrep and returns bounded structured matches", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-files-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    await mkdir(path.join(project, "src"), { recursive: true });
    await writeFile(path.join(project, "src", "a.ts"), "const needle = 1;\n", "utf8");
    await writeFile(path.join(project, "src", "b.txt"), "needle\n", "utf8");
    const workspaces = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const files = createFileService(workspaces, {
        recoveryDirectory: path.join(fixtureRoot, "trash"),
      });

      await expect(
        files.searchFiles({
          workspaceId: workspace.id,
          pattern: "needle",
          mode: "content",
          glob: "*.ts",
          maxResults: 10,
        }),
      ).resolves.toEqual({
        matches: [
          { path: "src/a.ts", line: 1, column: 7, text: "const needle = 1;" },
        ],
        truncated: false,
      });
    } finally {
      workspaces.close();
    }
  });

  it("finds file names by glob without returning file content", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-files-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    await mkdir(path.join(project, "src"), { recursive: true });
    await writeFile(path.join(project, "src", "one.test.ts"), "secret", "utf8");
    await writeFile(path.join(project, "src", "two.ts"), "secret", "utf8");
    const workspaces = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const files = createFileService(workspaces, {
        recoveryDirectory: path.join(fixtureRoot, "trash"),
      });

      await expect(
        files.searchFiles({
          workspaceId: workspace.id,
          pattern: "*.test.ts",
          mode: "files",
          maxResults: 10,
        }),
      ).resolves.toEqual({
        matches: [{ path: "src/one.test.ts", line: 0, column: 0, text: "" }],
        truncated: false,
      });
    } finally {
      workspaces.close();
    }
  });

  it("treats a leading-dash content pattern as a regular expression", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-files-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "notes.txt"), "--version is content\n", "utf8");
    const workspaces = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const files = createFileService(workspaces, {
        recoveryDirectory: path.join(fixtureRoot, "trash"),
      });

      await expect(files.searchFiles({
        workspaceId: workspace.id,
        pattern: "--version",
        mode: "content",
        maxResults: 10,
      })).resolves.toEqual({
        matches: [{ path: "notes.txt", line: 1, column: 1, text: "--version is content" }],
        truncated: false,
      });
    } finally {
      workspaces.close();
    }
  });

  it("imports a bounded base64 asset into an existing workspace directory", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-files-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    await mkdir(path.join(project, "assets"), { recursive: true });
    const workspaces = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const files = createFileService(workspaces, {
        recoveryDirectory: path.join(fixtureRoot, "trash"),
      });

      await expect(
        files.importAsset({
          workspaceId: workspace.id,
          path: "assets/pixel.bin",
          base64: Buffer.from([0, 1, 2, 255]).toString("base64"),
          mediaType: "application/octet-stream",
        }),
      ).resolves.toEqual({
        path: "assets/pixel.bin",
        mediaType: "application/octet-stream",
        bytesWritten: 4,
      });
      await expect(readFile(path.join(project, "assets", "pixel.bin"))).resolves.toEqual(
        Buffer.from([0, 1, 2, 255]),
      );
    } finally {
      workspaces.close();
    }
  });

  it("serializes concurrent directory creation and reports only the owner as creator", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-files-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    await mkdir(project, { recursive: true });
    const workspaces = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const files = createFileService(workspaces, {
        recoveryDirectory: path.join(fixtureRoot, "trash"),
      });
      const results = await Promise.all([
        files.makeDirectory({ workspaceId: workspace.id, path: "new/deep" }),
        files.makeDirectory({ workspaceId: workspace.id, path: "new/deep" }),
      ]);

      expect(results.map((result) => result.created).sort()).toEqual([false, true]);
      await expect(lstat(path.join(project, "new", "deep"))).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });
    } finally {
      workspaces.close();
    }
  });

  it("creates and lists directories, returns metadata, and reads multiple files", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-files-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    await mkdir(project, { recursive: true });
    const workspaces = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const files = createFileService(workspaces, {
        recoveryDirectory: path.join(fixtureRoot, "trash"),
      });

      await expect(files.makeDirectory({
        workspaceId: workspace.id,
        path: "src/nested",
      })).resolves.toEqual({ path: "src/nested", created: true });
      await expect(files.makeDirectory({
        workspaceId: workspace.id,
        path: "src/nested",
      })).resolves.toEqual({ path: "src/nested", created: false });
      await files.write({ workspaceId: workspace.id, path: "one.txt", content: "one\n" });
      await files.write({ workspaceId: workspace.id, path: "src/two.txt", content: "two\n" });

      const listing = await files.listDirectory({
        workspaceId: workspace.id,
        path: ".",
        depth: 2,
        maxEntries: 20,
      });
      expect(listing).toMatchObject({ path: ".", truncated: false });
      expect(listing.entries.map((entry) => [entry.path, entry.type])).toEqual([
        ["one.txt", "file"],
        ["src", "directory"],
        ["src/nested", "directory"],
        ["src/two.txt", "file"],
      ]);

      await expect(files.statPath({
        workspaceId: workspace.id,
        path: "one.txt",
        includeSha256: true,
      })).resolves.toMatchObject({
        path: "one.txt",
        type: "file",
        sizeBytes: 4,
        sha256: "2c8b08da5ce60398e1f19af0e5dccc744df274b826abe585eaba68c525434806",
      });
      await expect(files.readMany({
        workspaceId: workspace.id,
        files: [{ path: "one.txt" }, { path: "src/two.txt" }],
      })).resolves.toMatchObject({
        files: [
          { path: "one.txt", lines: ["one", ""] },
          { path: "src/two.txt", lines: ["two", ""] },
        ],
      });
    } finally {
      workspaces.close();
    }
  });

  it("copies and moves files and directories without overwriting", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-files-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    await mkdir(path.join(project, "src", "nested"), { recursive: true });
    await mkdir(path.join(project, "copies"));
    await mkdir(path.join(project, "moved"));
    await writeFile(path.join(project, "src", "nested", "value.txt"), "value", "utf8");
    const workspaces = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const files = createFileService(workspaces, {
        recoveryDirectory: path.join(fixtureRoot, "trash"),
      });

      await expect(files.copyPath({
        workspaceId: workspace.id,
        source: "src/nested",
        destination: "copies/nested-copy",
      })).resolves.toMatchObject({ type: "directory", entries: 2, bytes: 5 });
      await expect(readFile(path.join(project, "copies", "nested-copy", "value.txt"), "utf8"))
        .resolves.toBe("value");

      await expect(files.movePath({
        workspaceId: workspace.id,
        source: "copies/nested-copy/value.txt",
        destination: "moved/value.txt",
      })).resolves.toMatchObject({ type: "file", entries: 1, bytes: 5 });
      await expect(readFile(path.join(project, "moved", "value.txt"), "utf8")).resolves.toBe("value");
      await expect(files.copyPath({
        workspaceId: workspace.id,
        source: "src/nested/value.txt",
        destination: "moved/value.txt",
      })).rejects.toThrow("Destination already exists");
      await expect(files.movePath({
        workspaceId: workspace.id,
        source: "src",
        destination: "src/nested/inside",
      })).rejects.toThrow("into itself");
    } finally {
      workspaces.close();
    }
  });

  it("does not delete a destination created while a directory copy is staging", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-files-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    const source = path.join(project, "source");
    const destination = path.join(project, "destination");
    await mkdir(source, { recursive: true });
    for (let index = 0; index < 200; index += 1) {
      await writeFile(path.join(source, `file-${index}.txt`), `${index}\n`, "utf8");
    }
    const workspaces = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const files = createFileService(workspaces, {
        recoveryDirectory: path.join(fixtureRoot, "trash"),
      });
      const copyPromise = files.copyPath({
        workspaceId: workspace.id,
        source: "source",
        destination: "destination",
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await mkdir(destination);
      await writeFile(path.join(destination, "concurrent.txt"), "keep me", "utf8");

      await expect(copyPromise).rejects.toThrow();
      await expect(readFile(path.join(destination, "concurrent.txt"), "utf8"))
        .resolves.toBe("keep me");
    } finally {
      workspaces.close();
    }
  });

  it("recoverably deletes and restores paths and supports explicit permanent deletion", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-files-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    await mkdir(path.join(project, "tree"), { recursive: true });
    await writeFile(path.join(project, "tree", "value.txt"), "recover", "utf8");
    await writeFile(path.join(project, "permanent.txt"), "gone", "utf8");
    const workspaces = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const files = createFileService(workspaces, {
        recoveryDirectory: path.join(fixtureRoot, "trash"),
      });

      await expect(files.deletePath({
        workspaceId: workspace.id,
        path: "tree",
      })).rejects.toThrow("recursive=true");
      const deleted = await files.deletePath({
        workspaceId: workspace.id,
        path: "tree",
        recursive: true,
      });
      expect(deleted).toMatchObject({ permanent: false, type: "directory", entries: 2, bytes: 7 });
      expect(deleted.recoveryId).toEqual(expect.any(String));
      await expect(lstat(path.join(project, "tree"))).rejects.toThrow();

      await mkdir(path.join(project, "tree"));
      await expect(files.restorePath({
        workspaceId: workspace.id,
        recoveryId: deleted.recoveryId as string,
      })).rejects.toThrow("already exists");
      await rmdir(path.join(project, "tree"));
      await mkdir(path.join(project, "restored"));
      await expect(files.restorePath({
        workspaceId: workspace.id,
        recoveryId: deleted.recoveryId as string,
        destination: "restored/tree",
      })).resolves.toMatchObject({
        originalPath: "tree",
        restoredPath: "restored/tree",
        entries: 2,
        bytes: 7,
      });
      await expect(readFile(path.join(project, "restored", "tree", "value.txt"), "utf8"))
        .resolves.toBe("recover");

      await expect(files.deletePath({
        workspaceId: workspace.id,
        path: "permanent.txt",
        permanent: true,
      })).resolves.toMatchObject({ permanent: true, type: "file" });
      await expect(lstat(path.join(project, "permanent.txt"))).rejects.toThrow();
    } finally {
      workspaces.close();
    }
  });

  it("deletes and restores a junction without touching its target", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-files-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    const outside = path.join(allowedRoot, "outside");
    await mkdir(project, { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(outside, "target.txt"), "untouched", "utf8");
    await symlink(outside, path.join(project, "external-link"), "junction");
    const workspaces = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const files = createFileService(workspaces, {
        recoveryDirectory: path.join(fixtureRoot, "trash"),
      });
      const deleted = await files.deletePath({ workspaceId: workspace.id, path: "external-link" });
      expect(deleted.type).toBe("symlink");
      await expect(readFile(path.join(outside, "target.txt"), "utf8")).resolves.toBe("untouched");
      await expect(lstat(path.join(project, "external-link"))).rejects.toThrow();

      await files.restorePath({
        workspaceId: workspace.id,
        recoveryId: deleted.recoveryId as string,
      });
      await expect(lstat(path.join(project, "external-link"))).resolves.toMatchObject({});
      expect((await lstat(path.join(project, "external-link"))).isSymbolicLink()).toBe(true);
      await expect(readFile(path.join(outside, "target.txt"), "utf8")).resolves.toBe("untouched");
    } finally {
      workspaces.close();
    }
  });

  it("preserves a file symlink type when copying", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-files-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    await mkdir(path.join(project, "copies"), { recursive: true });
    await writeFile(path.join(project, "target.txt"), "target", "utf8");
    try {
      await symlink(
        path.join(project, "target.txt"),
        path.join(project, "file-link"),
        process.platform === "win32" ? "file" : undefined,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const workspaces = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const files = createFileService(workspaces, {
        recoveryDirectory: path.join(fixtureRoot, "trash"),
      });
      await files.copyPath({
        workspaceId: workspace.id,
        source: "file-link",
        destination: "copies/file-link",
      });

      const copiedStats = await lstat(path.join(project, "copies", "file-link"));
      expect(copiedStats.isSymbolicLink()).toBe(true);
      await expect(readlink(path.join(project, "copies", "file-link"))).resolves.toBe(
        await readlink(path.join(project, "file-link")),
      );
    } finally {
      workspaces.close();
    }
  });

  it("rebases relative symlink targets when copying to a different directory", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-files-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    await mkdir(path.join(project, "copies"), { recursive: true });
    await writeFile(path.join(project, "target.txt"), "target", "utf8");
    try {
      await symlink(
        "target.txt",
        path.join(project, "relative-link"),
        process.platform === "win32" ? "file" : undefined,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const workspaces = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const files = createFileService(workspaces, {
        recoveryDirectory: path.join(fixtureRoot, "trash"),
      });
      await files.copyPath({
        workspaceId: workspace.id,
        source: "relative-link",
        destination: "copies/relative-link",
      });

      await expect(readFile(path.join(project, "copies", "relative-link"), "utf8"))
        .resolves.toBe("target");
    } finally {
      workspaces.close();
    }
  });

  it("dry-runs and applies structured patches without partial preflight writes", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-files-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    await mkdir(path.join(project, "src"), { recursive: true });
    await writeFile(path.join(project, "README.md"), "MARKER: original\n", "utf8");
    await writeFile(path.join(project, "src", "delete.txt"), "delete-me\n", "utf8");
    await writeFile(path.join(project, "src", "stable.txt"), "stable\n", "utf8");
    const workspaces = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const files = createFileService(workspaces, {
        recoveryDirectory: path.join(fixtureRoot, "trash"),
      });
      const deleteStat = await files.statPath({
        workspaceId: workspace.id,
        path: "src/delete.txt",
        includeSha256: true,
      });
      const operations = [
        { op: "create_file" as const, path: "src/generated.txt", content: "generated\n" },
        { op: "edit_file" as const, path: "README.md", oldText: "original", newText: "changed" },
        { op: "delete_file" as const, path: "src/delete.txt", expectedSha256: deleteStat.sha256 as string },
      ];

      await expect(files.applyPatch({
        workspaceId: workspace.id,
        operations,
        dryRun: true,
      })).resolves.toMatchObject({ dryRun: true, applied: false, changes: [{}, {}, {}] });
      await expect(readFile(path.join(project, "README.md"), "utf8")).resolves.toBe("MARKER: original\n");
      await expect(lstat(path.join(project, "src", "generated.txt"))).rejects.toThrow();

      await expect(files.applyPatch({ workspaceId: workspace.id, operations })).resolves.toMatchObject({
        dryRun: false,
        applied: true,
      });
      await expect(readFile(path.join(project, "README.md"), "utf8")).resolves.toBe("MARKER: changed\n");
      await expect(readFile(path.join(project, "src", "generated.txt"), "utf8")).resolves.toBe("generated\n");
      await expect(lstat(path.join(project, "src", "delete.txt"))).rejects.toThrow();

      await expect(files.applyPatch({
        workspaceId: workspace.id,
        operations: [
          { op: "edit_file", path: "README.md", oldText: "changed", newText: "should-not-apply" },
          { op: "edit_file", path: "src/stable.txt", oldText: "missing", newText: "bad" },
        ],
      })).rejects.toThrow("found 0");
      await expect(readFile(path.join(project, "README.md"), "utf8")).resolves.toBe("MARKER: changed\n");
    } finally {
      workspaces.close();
    }
  });

  it("does not roll back over an external edit made after the first patch operation", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-files-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "first.txt"), "first\n", "utf8");
    await writeFile(path.join(project, "second.txt"), "second\n", "utf8");
    const workspaces = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });
    let externalChangeInjected = false;
    const racingWorkspaces: WorkspaceService = {
      openWorkspace: workspaces.openWorkspace.bind(workspaces),
      listWorkspaces: workspaces.listWorkspaces.bind(workspaces),
      resumeWorkspace: workspaces.resumeWorkspace.bind(workspaces),
      resolveExistingPath: workspaces.resolveExistingPath.bind(workspaces),
      resolveEntryPath: workspaces.resolveEntryPath.bind(workspaces),
      resolveWorkspaceRoot: workspaces.resolveWorkspaceRoot.bind(workspaces),
      resolvePathForCreate: workspaces.resolvePathForCreate.bind(workspaces),
      close: workspaces.close.bind(workspaces),
      resolvePathForWrite: async (workspaceId, relativePath) => {
        const resolved = await workspaces.resolvePathForWrite(workspaceId, relativePath);
        if (relativePath === "second.txt" && !externalChangeInjected) {
          externalChangeInjected = true;
          await writeFile(path.join(project, "first.txt"), "external\n", "utf8");
          await writeFile(path.join(project, "second.txt"), "changed by external writer\n", "utf8");
        }
        return resolved;
      },
    };

    try {
      const workspace = await workspaces.openWorkspace(project);
      const files = createFileService(racingWorkspaces, {
        recoveryDirectory: path.join(fixtureRoot, "trash"),
      });

      await expect(files.applyPatch({
        workspaceId: workspace.id,
        operations: [
          { op: "edit_file", path: "first.txt", oldText: "first", newText: "toolspan" },
          { op: "edit_file", path: "second.txt", oldText: "second", newText: "toolspan" },
        ],
      })).rejects.toThrow(/rollback errors|Patch target changed/);
      await expect(readFile(path.join(project, "first.txt"), "utf8")).resolves.toBe("external\n");
      await expect(readFile(path.join(project, "second.txt"), "utf8"))
        .resolves.toBe("changed by external writer\n");
    } finally {
      workspaces.close();
    }
  });

  it("cleans a committed recovery directory when delete verification fails", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "webgpt-files-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    const recoveryDirectory = path.join(fixtureRoot, "trash");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "value.txt"), "value", "utf8");
    const workspaces = await createWorkspaceService({
      allowedRoots: [allowedRoot],
      databasePath: path.join(fixtureRoot, "state.sqlite"),
    });
    let resolveCount = 0;
    const failingWorkspaces: WorkspaceService = {
      openWorkspace: workspaces.openWorkspace.bind(workspaces),
      listWorkspaces: workspaces.listWorkspaces.bind(workspaces),
      resumeWorkspace: workspaces.resumeWorkspace.bind(workspaces),
      resolveExistingPath: workspaces.resolveExistingPath.bind(workspaces),
      resolvePathForWrite: workspaces.resolvePathForWrite.bind(workspaces),
      resolvePathForCreate: workspaces.resolvePathForCreate.bind(workspaces),
      resolveWorkspaceRoot: workspaces.resolveWorkspaceRoot.bind(workspaces),
      close: workspaces.close.bind(workspaces),
      resolveEntryPath: async (workspaceId, relativePath) => {
        const resolved = await workspaces.resolveEntryPath(workspaceId, relativePath);
        resolveCount += 1;
        return resolveCount === 2 ? path.join(project, "different.txt") : resolved;
      },
    };

    try {
      const workspace = await workspaces.openWorkspace(project);
      const files = createFileService(failingWorkspaces, { recoveryDirectory });

      await expect(files.deletePath({
        workspaceId: workspace.id,
        path: "value.txt",
      })).rejects.toThrow("Path changed during delete");
      await expect(readdir(path.join(recoveryDirectory, workspace.id))).resolves.toHaveLength(0);
      await expect(readFile(path.join(project, "value.txt"), "utf8")).resolves.toBe("value");
    } finally {
      workspaces.close();
    }
  });
});
