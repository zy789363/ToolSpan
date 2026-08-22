import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createArtifactService } from "../src/artifacts/artifact-service.js";
import { createFileService } from "../src/files/file-service.js";
import { createHttpApp } from "../src/http-app.js";
import { createJobService } from "../src/jobs/job-service.js";
import { createWorkspaceService } from "../src/workspaces/workspace-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("artifact HTTP routes", () => {
  it("serves valid preview and published URLs with hardened response headers", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "webgpt-artifact-http-"));
    temporaryDirectories.push(directory);
    const allowedRoot = path.join(directory, "projects");
    const project = path.join(allowedRoot, "demo");
    const databasePath = path.join(directory, "state.sqlite");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "hello.txt"), "hello\n", "utf8");
    const workspaces = await createWorkspaceService({ allowedRoots: [allowedRoot], databasePath });
    const files = createFileService(workspaces, {
      recoveryDirectory: path.join(directory, "trash"),
    });
    const jobs = await createJobService({
      workspaces,
      databasePath,
      jobsDirectory: path.join(directory, "jobs"),
      runners: {},
    });
    const artifacts = await createArtifactService({
      workspaces,
      jobs,
      databasePath,
      artifactsDirectory: path.join(directory, "artifacts"),
      publicBaseUrl: "https://mcp.example.test",
      previewSecret: Buffer.alloc(32, 5),
    });
    const app = createHttpApp({
      mcp: {
        workspaces,
        files,
        jobs,
        artifacts,
        runnerNames: [],
        startedAt: Date.now(),
        protectedResourceMetadataUrl: "https://mcp.example.test/.well-known/oauth-protected-resource",
      },
    });

    try {
      const workspace = await workspaces.openWorkspace(project);
      const artifact = await artifacts.startCapture({
        workspaceId: workspace.id,
        profile: "workspace_snapshot",
      });
      const preview = await artifacts.previewArtifact(artifact.id, 60);
      const previewPath = new URL(preview.url).pathname;
      await request(app)
        .get(previewPath)
        .expect(200)
        .expect("X-Content-Type-Options", "nosniff")
        .expect("Cache-Control", "no-store")
        .expect(({ text }) => expect(text).toContain("hello.txt"));

      const published = await artifacts.publishArtifact(artifact.id);
      await request(app)
        .get(new URL(published.url).pathname)
        .expect(200)
        .expect("Cache-Control", "public, max-age=300")
        .expect(({ text }) => expect(text).toContain("hello.txt"));
      await request(app).get("/artifacts/preview/not-a-token").expect(404);
    } finally {
      artifacts.close();
      await jobs.close();
      workspaces.close();
    }
  });

  it("rejects unexpected Host headers and oversized MCP JSON", async () => {
    const app = createHttpApp();
    await request(app).get("/healthz").set("Host", "evil.example").expect(403);
    await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .set("Content-Type", "application/json")
      .send({ padding: "x".repeat(36 * 1024 * 1024) })
      .expect(413);
  });
});
