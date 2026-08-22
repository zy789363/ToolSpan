import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { createArtifactService } from "../src/artifacts/artifact-service.js";
import { createJobService } from "../src/jobs/job-service.js";
import { createWorkspaceService } from "../src/workspaces/workspace-service.js";

const execFileAsync = promisify(execFile);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("artifact service", () => {
  it("captures and inspects a persisted workspace snapshot", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "toolspan-artifacts-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    const databasePath = path.join(fixtureRoot, "state.sqlite");
    await mkdir(path.join(project, "src"), { recursive: true });
    await writeFile(path.join(project, "src", "app.ts"), "export {};\n", "utf8");
    const workspaces = await createWorkspaceService({ allowedRoots: [allowedRoot], databasePath });
    const artifacts = await createArtifactService({
      workspaces,
      databasePath,
      artifactsDirectory: path.join(fixtureRoot, "artifacts"),
      publicBaseUrl: "https://mcp.example.test",
      previewSecret: Buffer.alloc(32, 7),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const captured = await artifacts.startCapture({
        workspaceId: workspace.id,
        profile: "workspace_snapshot",
      });

      expect(captured).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          workspaceId: workspace.id,
          profile: "workspace_snapshot",
          mediaType: "application/json",
        }),
      );
      await expect(artifacts.inspectArtifact(captured.id)).resolves.toEqual(
        expect.objectContaining({
          artifact: expect.objectContaining({ id: captured.id }),
          preview: expect.stringContaining("src/app.ts"),
        }),
      );
      await expect(artifacts.listArtifacts(workspace.id)).resolves.toHaveLength(1);
    } finally {
      artifacts.close();
      workspaces.close();
    }
  });

  it("captures git changes and completed job output", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "toolspan-artifact-profiles-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    const databasePath = path.join(fixtureRoot, "state.sqlite");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "tracked.txt"), "before\n", "utf8");
    await execFileAsync("git", ["init"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "test@example.test"], { cwd: project });
    await execFileAsync("git", ["config", "user.name", "ToolSpan Test"], { cwd: project });
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: project });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: project });
    await writeFile(path.join(project, "tracked.txt"), "after\n", "utf8");

    const workspaces = await createWorkspaceService({ allowedRoots: [allowedRoot], databasePath });
    const jobs = await createJobService({
      workspaces,
      databasePath,
      jobsDirectory: path.join(fixtureRoot, "jobs"),
      runners: {
        echo: {
          executable: process.execPath,
          validateArgs: () => true,
          maxConcurrent: 1,
          maxTimeoutSeconds: 5,
          maxOutputBytes: 1024,
          inheritEnvironment: true,
        },
      },
    });
    const artifacts = await createArtifactService({
      workspaces,
      jobs,
      databasePath,
      artifactsDirectory: path.join(fixtureRoot, "artifacts"),
      publicBaseUrl: "https://mcp.example.test",
      previewSecret: Buffer.alloc(32, 7),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const diff = await artifacts.startCapture({
        workspaceId: workspace.id,
        profile: "git_diff",
      });
      await expect(artifacts.inspectArtifact(diff.id)).resolves.toEqual(
        expect.objectContaining({ preview: expect.stringContaining("-before") }),
      );

      const job = await jobs.startJob({
        workspaceId: workspace.id,
        runner: "echo",
        args: ["-e", "process.stdout.write('captured job output')"],
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const polled = await jobs.pollJob({ jobId: job.id });
        if (polled.job.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const output = await artifacts.startCapture({
        workspaceId: workspace.id,
        profile: "job_output",
        jobId: job.id,
      });
      await expect(artifacts.inspectArtifact(output.id)).resolves.toEqual(
        expect.objectContaining({ preview: "captured job output" }),
      );
    } finally {
      artifacts.close();
      await jobs.close();
      workspaces.close();
    }
  });

  it("creates expiring preview links and stable published links without storing raw tokens", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "toolspan-artifact-links-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "projects");
    const project = path.join(allowedRoot, "demo");
    const databasePath = path.join(fixtureRoot, "state.sqlite");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "readme.txt"), "public preview\n", "utf8");
    const workspaces = await createWorkspaceService({ allowedRoots: [allowedRoot], databasePath });
    const artifacts = await createArtifactService({
      workspaces,
      databasePath,
      artifactsDirectory: path.join(fixtureRoot, "artifacts"),
      publicBaseUrl: "https://mcp.example.test/base/",
      previewSecret: Buffer.alloc(32, 9),
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const captured = await artifacts.startCapture({
        workspaceId: workspace.id,
        profile: "workspace_snapshot",
      });
      const preview = await artifacts.previewArtifact(captured.id, 120);
      expect(preview.url).toMatch(/^https:\/\/mcp\.example\.test\/base\/artifacts\/preview\//);
      const token = preview.url.split("/").at(-1);
      expect(token).toEqual(expect.any(String));
      await expect(artifacts.resolvePreview(token!)).resolves.toEqual(
        expect.objectContaining({ id: captured.id }),
      );

      const first = await artifacts.publishArtifact(captured.id);
      const second = await artifacts.publishArtifact(captured.id);
      expect(second).toEqual(first);
      const slug = first.url.split("/").at(-1);
      await expect(artifacts.resolvePublished(slug!)).resolves.toEqual(
        expect.objectContaining({ id: captured.id }),
      );
    } finally {
      artifacts.close();
      workspaces.close();
    }
  });
});
