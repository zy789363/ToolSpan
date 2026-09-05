import path from "node:path";

import { createArtifactService } from "./artifacts/artifact-service.js";
import { createOAuthService } from "./auth/oauth-service.js";
import type { ToolSpanConfig } from "./config.js";
import { createFileService } from "./files/file-service.js";
import { createHttpApp } from "./http-app.js";
import { createProductionRunners, inspectRunnerAvailability } from "./jobs/runner-registry.js";
import { createJobService } from "./jobs/job-service.js";
import { createWorkspaceService } from "./workspaces/workspace-service.js";

export async function createRuntime(config: ToolSpanConfig) {
  const databasePath = path.join(config.stateDirectory, "state.sqlite");
  let workspaces: Awaited<ReturnType<typeof createWorkspaceService>> | undefined;
  let jobs: Awaited<ReturnType<typeof createJobService>> | undefined;
  let artifacts: Awaited<ReturnType<typeof createArtifactService>> | undefined;
  let oauth: ReturnType<typeof createOAuthService> | undefined;

  try {
    workspaces = await createWorkspaceService({
      allowedRoots: config.allowedRoots,
      databasePath,
    });
    const runners = createProductionRunners();
    jobs = await createJobService({
      workspaces,
      databasePath,
      jobsDirectory: path.join(config.stateDirectory, "jobs"),
      runners,
    });
    const files = createFileService(workspaces, {
      recoveryDirectory: path.join(config.stateDirectory, "trash"),
    });
    artifacts = await createArtifactService({
      workspaces,
      jobs,
      databasePath,
      artifactsDirectory: path.join(config.stateDirectory, "artifacts"),
      publicBaseUrl: config.publicBaseUrl,
      previewSecret: config.previewSecret,
    });
    oauth = createOAuthService({
      databasePath,
      issuer: config.publicBaseUrl,
      resource: `${config.publicBaseUrl}/mcp`,
      ownerPasswordHash: config.ownerPasswordHash,
    });
    const startedAt = Date.now();
    const app = createHttpApp({
      allowedHosts: config.allowedHosts,
      allowedOrigins: config.allowedOrigins,
      instanceName: config.instanceName,
      oauth,
      mcp: {
        workspaces,
        files,
        jobs,
        artifacts,
        runnerNames: Object.keys(runners),
        inspectRunners: () => inspectRunnerAvailability(runners),
        instanceName: config.instanceName,
        startedAt,
        protectedResourceMetadataUrl: oauth.protectedResourceMetadataUrl,
      },
    });
    let closed = false;

    return {
      app,
      services: {
        workspaces,
        jobs,
        artifacts,
        startedAt,
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await jobs!.close();
        artifacts!.close();
        oauth!.close();
        workspaces!.close();
      },
    };
  } catch (error) {
    try { await jobs?.close(); } catch { /* Preserve the original startup error. */ }
    try { artifacts?.close(); } catch { /* Preserve the original startup error. */ }
    try { oauth?.close(); } catch { /* Preserve the original startup error. */ }
    try { workspaces?.close(); } catch { /* Preserve the original startup error. */ }
    throw error;
  }
}
