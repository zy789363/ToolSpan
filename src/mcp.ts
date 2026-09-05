import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Express, Request, Response } from "express";
import { z } from "zod";

import type { ArtifactRecord, ArtifactService } from "./artifacts/artifact-service.js";
import type { AuthContext, OAuthScope } from "./auth/oauth-service.js";
import type { FileService } from "./files/file-service.js";
import type { JobRecord, JobService } from "./jobs/job-service.js";
import { ToolSpanToolRegistry, type ToolSecurityScheme } from "./mcp-tool-registry.js";
import { SERVICE_INFO } from "./service-info.js";
import type { WorkspaceService } from "./workspaces/workspace-service.js";

export interface McpServices {
  workspaces: WorkspaceService;
  files: FileService;
  jobs: JobService;
  artifacts: ArtifactService;
  runnerNames: readonly string[];
  inspectRunners?: () => Promise<Array<{ name: string; available: boolean }>>;
  startedAt: number;
  protectedResourceMetadataUrl: string;
  instanceName?: string;
}

const annotations = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  write: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  internalWrite: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  idempotentWrite: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  publish: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
} as const;

function securityMeta(scope: OAuthScope): { securitySchemes: ToolSecurityScheme[] } {
  return { securitySchemes: [{ type: "oauth2", scopes: [scope] }] };
}

function publicJob(job: JobRecord): Record<string, unknown> {
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    runner: job.runner,
    args: job.args,
    status: job.status,
    pid: job.pid,
    exitCode: job.exitCode,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

function publicArtifact(artifact: ArtifactRecord): Record<string, unknown> {
  return {
    id: artifact.id,
    workspaceId: artifact.workspaceId,
    profile: artifact.profile,
    jobId: artifact.jobId,
    mediaType: artifact.mediaType,
    size: artifact.size,
    sha256: artifact.sha256,
    createdAt: artifact.createdAt,
    published: artifact.publishedSlug !== null,
  };
}

function toolResult(value: object): CallToolResult {
  const structuredContent = { ...value } as Record<string, unknown>;
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

const TOOL_EXECUTION_ERROR = {
  code: "tool_execution_failed",
  message: "Tool execution failed",
} as const;

function toolError(): CallToolResult {
  const structuredContent = { error: TOOL_EXECUTION_ERROR };
  return {
    content: [{ type: "text", text: TOOL_EXECUTION_ERROR.message }],
    structuredContent,
    isError: true,
  };
}

async function runTool(
  auth: AuthContext | undefined,
  scope: OAuthScope,
  metadataUrl: string,
  operation: () => Promise<object>,
): Promise<CallToolResult> {
  if (auth !== undefined && !auth.scopes.has(scope)) {
    return {
      content: [{ type: "text", text: `Authorization requires the ${scope} scope.` }],
      _meta: {
        "mcp/www_authenticate": [
          `Bearer resource_metadata="${metadataUrl}", error="insufficient_scope", error_description="Required scope: ${scope}"`,
        ],
      },
      isError: true,
    };
  }
  try {
    return toolResult(await operation());
  } catch {
    return toolError();
  }
}

export function createMcpServer(
  services: McpServices | undefined,
  auth?: AuthContext,
): { server: McpServer; registry: ToolSpanToolRegistry } {
  const protocolServer = new McpServer(
    { name: SERVICE_INFO.service, version: SERVICE_INFO.version },
    {
      capabilities: { tools: {} },
      instructions:
        "Open a workspace before workspace-scoped tools. Inspect with list_directory, stat_path, and read_many. Use apply_patch dryRun before multi-file changes. delete_path is recoverable by default; retain recoveryId. Long-running commands use start_job and poll_job. For SVN working copies, use runner 'svn' only with status, diff, info, or log; do not read .svn metadata directly.",
    },
  );
  const server = new ToolSpanToolRegistry(protocolServer);
  if (services === undefined) return { server: protocolServer, registry: server };
  const metadataUrl = services.protectedResourceMetadataUrl;
  const execute = (
    scope: OAuthScope,
    operation: () => Promise<object>,
  ): Promise<CallToolResult> => runTool(auth, scope, metadataUrl, operation);

  server.registerTool("open_workspace", {
    title: "Open workspace",
    description: "Open an existing directory under a configured allowed root.",
    inputSchema: { path: z.string().min(1).max(4096) },
    annotations: annotations.internalWrite,
    _meta: securityMeta("workspace:read"),
  }, ({ path }) => execute("workspace:read", async () => services.workspaces.openWorkspace(path)));

  server.registerTool("list_workspaces", {
    title: "List workspaces",
    description: "List persisted workspaces without scanning the filesystem.",
    inputSchema: { status: z.enum(["active", "history"]).optional() },
    annotations: annotations.read,
    _meta: securityMeta("workspace:read"),
  }, ({ status }) => execute("workspace:read", async () => ({
    workspaces: await services.workspaces.listWorkspaces(status),
  })));

  server.registerTool("resume_workspace", {
    title: "Resume workspace",
    description: "Revalidate and reactivate a persisted workspace.",
    inputSchema: { workspaceId: z.string().uuid() },
    annotations: annotations.internalWrite,
    _meta: securityMeta("workspace:read"),
  }, ({ workspaceId }) => execute("workspace:read", async () => services.workspaces.resumeWorkspace(workspaceId)));

  server.registerTool("read", {
    title: "Read file",
    description: "Read a bounded page of UTF-8 lines from a workspace file.",
    inputSchema: {
      workspaceId: z.string().uuid(),
      path: z.string().min(1).max(4096),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    annotations: annotations.read,
    _meta: securityMeta("workspace:read"),
  }, (input) => execute("workspace:read", async () => services.files.read(input)));

  server.registerTool("write", {
    title: "Write file",
    description: "Atomically create or replace a UTF-8 workspace file whose parent exists.",
    inputSchema: {
      workspaceId: z.string().uuid(),
      path: z.string().min(1).max(4096),
      content: z.string().max(1024 * 1024),
    },
    annotations: annotations.write,
    _meta: securityMeta("workspace:write"),
  }, (input) => execute("workspace:write", async () => services.files.write(input)));

  server.registerTool("edit", {
    title: "Edit file",
    description: "Atomically replace exactly one occurrence of text in a workspace file.",
    inputSchema: {
      workspaceId: z.string().uuid(),
      path: z.string().min(1).max(4096),
      oldText: z.string().min(1).max(1024 * 1024),
      newText: z.string().max(1024 * 1024),
    },
    annotations: annotations.write,
    _meta: securityMeta("workspace:write"),
  }, (input) => execute("workspace:write", async () => services.files.edit(input)));

  server.registerTool("search_files", {
    title: "Search files",
    description: "Search workspace contents with a regular expression or list matching file names.",
    inputSchema: {
      workspaceId: z.string().uuid(),
      pattern: z.string().min(1).max(1000),
      mode: z.enum(["content", "files"]),
      glob: z.string().max(1000).optional(),
      maxResults: z.number().int().min(1).max(200).optional(),
    },
    annotations: annotations.read,
    _meta: securityMeta("workspace:read"),
  }, (input) => execute("workspace:read", async () => services.files.searchFiles(input)));

  server.registerTool("list_directory", {
    title: "List directory",
    description: "List a bounded workspace directory tree without following symbolic links.",
    inputSchema: {
      workspaceId: z.string().uuid(),
      path: z.string().min(1).max(4096).optional(),
      depth: z.number().int().min(1).max(5).optional(),
      maxEntries: z.number().int().min(1).max(1000).optional(),
    },
    annotations: annotations.read,
    _meta: securityMeta("workspace:read"),
  }, (input) => execute("workspace:read", async () => services.files.listDirectory(input)));

  server.registerTool("stat_path", {
    title: "Stat path",
    description: "Return metadata and an optional SHA-256 digest for a workspace path.",
    inputSchema: {
      workspaceId: z.string().uuid(),
      path: z.string().min(1).max(4096),
      includeSha256: z.boolean().optional(),
    },
    annotations: annotations.read,
    _meta: securityMeta("workspace:read"),
  }, (input) => execute("workspace:read", async () => services.files.statPath(input)));

  server.registerTool("make_directory", {
    title: "Make directory",
    description: "Create a workspace directory, including missing parents by default.",
    inputSchema: {
      workspaceId: z.string().uuid(),
      path: z.string().min(1).max(4096),
      recursive: z.boolean().optional(),
    },
    annotations: annotations.idempotentWrite,
    _meta: securityMeta("workspace:write"),
  }, (input) => execute("workspace:write", async () => services.files.makeDirectory(input)));

  server.registerTool("move_path", {
    title: "Move path",
    description: "Move a workspace file, directory, or link without overwriting the destination.",
    inputSchema: {
      workspaceId: z.string().uuid(),
      source: z.string().min(1).max(4096),
      destination: z.string().min(1).max(4096),
    },
    annotations: annotations.write,
    _meta: securityMeta("workspace:write"),
  }, (input) => execute("workspace:write", async () => services.files.movePath(input)));

  server.registerTool("copy_path", {
    title: "Copy path",
    description: "Copy a bounded workspace file or directory without following links or overwriting.",
    inputSchema: {
      workspaceId: z.string().uuid(),
      source: z.string().min(1).max(4096),
      destination: z.string().min(1).max(4096),
    },
    annotations: annotations.internalWrite,
    _meta: securityMeta("workspace:write"),
  }, (input) => execute("workspace:write", async () => services.files.copyPath(input)));

  server.registerTool("delete_path", {
    title: "Delete path",
    description: "Move a workspace path to recoverable storage unless permanent deletion is explicit.",
    inputSchema: {
      workspaceId: z.string().uuid(),
      path: z.string().min(1).max(4096),
      recursive: z.boolean().optional(),
      permanent: z.boolean().optional(),
    },
    annotations: annotations.write,
    _meta: securityMeta("workspace:write"),
  }, (input) => execute("workspace:write", async () => services.files.deletePath(input)));

  server.registerTool("restore_path", {
    title: "Restore path",
    description: "Restore a recoverably deleted path without overwriting its destination.",
    inputSchema: {
      workspaceId: z.string().uuid(),
      recoveryId: z.string().uuid(),
      destination: z.string().min(1).max(4096).optional(),
    },
    annotations: annotations.internalWrite,
    _meta: securityMeta("workspace:write"),
  }, (input) => execute("workspace:write", async () => services.files.restorePath(input)));

  server.registerTool("read_many", {
    title: "Read many files",
    description: "Read bounded pages from up to 20 UTF-8 workspace files in one call.",
    inputSchema: {
      workspaceId: z.string().uuid(),
      files: z.array(z.object({
        path: z.string().min(1).max(4096),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      })).min(1).max(20),
    },
    annotations: annotations.read,
    _meta: securityMeta("workspace:read"),
  }, (input) => execute("workspace:read", async () => services.files.readMany(input)));

  server.registerTool("apply_patch", {
    title: "Apply structured patch",
    description: "Validate and transactionally apply up to 50 structured text file operations.",
    inputSchema: {
      workspaceId: z.string().uuid(),
      operations: z.array(z.discriminatedUnion("op", [
        z.object({
          op: z.literal("create_file"),
          path: z.string().min(1).max(4096),
          content: z.string().max(1024 * 1024),
        }),
        z.object({
          op: z.literal("edit_file"),
          path: z.string().min(1).max(4096),
          oldText: z.string().min(1).max(1024 * 1024),
          newText: z.string().max(1024 * 1024),
        }),
        z.object({
          op: z.literal("delete_file"),
          path: z.string().min(1).max(4096),
          expectedSha256: z.string().regex(/^[0-9a-f]{64}$/iu),
        }),
      ])).min(1).max(50),
      dryRun: z.boolean().optional(),
    },
    annotations: annotations.write,
    _meta: securityMeta("workspace:write"),
  }, (input) => execute("workspace:write", async () => services.files.applyPatch(input)));

  server.registerTool("start_job", {
    title: "Start background job",
    description: "Start a configured runner asynchronously without invoking a command shell.",
    inputSchema: {
      workspaceId: z.string().uuid(),
      runner: z.string().min(1).max(100),
      args: z.array(z.string().max(4096)).max(100),
    },
    annotations: annotations.run,
    _meta: securityMeta("jobs:run"),
  }, (input) => execute("jobs:run", async () => publicJob(await services.jobs.startJob(input))));

  server.registerTool("poll_job", {
    title: "Poll background job",
    description: "Return current job state and the next bounded output page.",
    inputSchema: {
      jobId: z.string().uuid(),
      cursor: z.number().int().min(0).optional(),
    },
    annotations: annotations.read,
    _meta: securityMeta("workspace:read"),
  }, (input) => execute("workspace:read", async () => {
    const result = await services.jobs.pollJob(input);
    return { ...result, job: publicJob(result.job) };
  }));

  server.registerTool("cancel_job", {
    title: "Cancel background job",
    description: "Terminate a running job process tree.",
    inputSchema: { jobId: z.string().uuid() },
    annotations: annotations.write,
    _meta: securityMeta("jobs:run"),
  }, ({ jobId }) => execute("jobs:run", async () => publicJob(await services.jobs.cancelJob(jobId))));

  server.registerTool("list_jobs", {
    title: "List jobs",
    description: "List persisted job summaries with optional workspace and status filters.",
    inputSchema: {
      workspaceId: z.string().uuid().optional(),
      status: z.enum(["queued", "running", "completed", "failed", "cancelled", "timed_out", "interrupted"]).optional(),
    },
    annotations: annotations.read,
    _meta: securityMeta("workspace:read"),
  }, ({ workspaceId, status }) => execute("workspace:read", async () => ({
    jobs: (await services.jobs.listJobs(workspaceId, status)).map(publicJob),
  })));

  server.registerTool("start_capture", {
    title: "Capture artifact",
    description: "Capture a workspace snapshot, Git diff, or job output in the isolated artifact store.",
    inputSchema: {
      workspaceId: z.string().uuid(),
      profile: z.enum(["workspace_snapshot", "git_diff", "job_output"]),
      jobId: z.string().uuid().optional(),
    },
    annotations: annotations.internalWrite,
    _meta: securityMeta("workspace:read"),
  }, (input) => execute("workspace:read", async () => publicArtifact(await services.artifacts.startCapture(input))));

  server.registerTool("inspect_artifact", {
    title: "Inspect artifact",
    description: "Return artifact metadata and a bounded textual preview.",
    inputSchema: { artifactId: z.string().uuid() },
    annotations: annotations.read,
    _meta: securityMeta("workspace:read"),
  }, ({ artifactId }) => execute("workspace:read", async () => {
    const result = await services.artifacts.inspectArtifact(artifactId);
    return { artifact: publicArtifact(result.artifact), preview: result.preview };
  }));

  server.registerTool("list_artifacts", {
    title: "List artifacts",
    description: "List persisted artifact metadata.",
    inputSchema: { workspaceId: z.string().uuid().optional() },
    annotations: annotations.read,
    _meta: securityMeta("workspace:read"),
  }, ({ workspaceId }) => execute("workspace:read", async () => ({
    artifacts: (await services.artifacts.listArtifacts(workspaceId)).map(publicArtifact),
  })));

  server.registerTool("preview_artifact", {
    title: "Preview artifact",
    description: "Create a signed public artifact URL that expires after 60 to 3600 seconds.",
    inputSchema: {
      artifactId: z.string().uuid(),
      ttlSeconds: z.number().int().min(60).max(3600).optional(),
    },
    annotations: annotations.publish,
    _meta: securityMeta("artifacts:publish"),
  }, ({ artifactId, ttlSeconds }) => execute(
    "artifacts:publish",
    async () => services.artifacts.previewArtifact(artifactId, ttlSeconds),
  ));

  server.registerTool("publish_artifact", {
    title: "Publish artifact",
    description: "Explicitly create or return a persistent public artifact URL.",
    inputSchema: { artifactId: z.string().uuid() },
    annotations: annotations.publish,
    _meta: securityMeta("artifacts:publish"),
  }, ({ artifactId }) => execute("artifacts:publish", async () => services.artifacts.publishArtifact(artifactId)));

  server.registerTool("devspace_info", {
    title: "Devspace information",
    description: "Return bounded health, capacity, runner, and persisted object counts.",
    annotations: annotations.read,
    _meta: securityMeta("workspace:read"),
  }, () => execute("workspace:read", async () => {
    const [workspaces, jobs, artifacts] = await Promise.all([
      services.workspaces.listWorkspaces(),
      services.jobs.listJobs(),
      services.artifacts.listArtifacts(),
    ]);
    const memory = process.memoryUsage();
    return {
      service: SERVICE_INFO.service,
      version: SERVICE_INFO.version,
      ...(services.instanceName === undefined ? {} : { instanceName: services.instanceName }),
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - services.startedAt) / 1000)),
      memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
      database: "ok",
      runners: services.inspectRunners === undefined
        ? services.runnerNames.map((name) => ({ name, available: true }))
        : await services.inspectRunners(),
      counts: { workspaces: workspaces.length, jobs: jobs.length, artifacts: artifacts.length },
    };
  }));

  server.registerTool("import_asset", {
    title: "Import asset",
    description: "Decode and atomically import up to 25 MiB of base64 data into a workspace.",
    inputSchema: {
      workspaceId: z.string().uuid(),
      path: z.string().min(1).max(4096),
      base64: z.string().max(35 * 1024 * 1024),
      mediaType: z.string().min(3).max(255),
    },
    annotations: annotations.write,
    _meta: securityMeta("workspace:write"),
  }, (input) => execute("workspace:write", async () => services.files.importAsset(input)));

  server.installListHandler();
  return { server: protocolServer, registry: server };
}

async function handleMcpRequest(
  request: Request,
  response: Response,
  services: McpServices | undefined,
): Promise<void> {
  const auth = response.locals.auth as AuthContext | undefined;
  const { server } = createMcpServer(services, auth);
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });

  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  } catch {
    if (!response.headersSent) {
      response.status(500).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "Internal server error" },
      });
    }
  } finally {
    await transport.close();
    await server.close();
  }
}

export function registerMcpEndpoint(app: Express, services?: McpServices): void {
  app.post("/mcp", (request, response) => {
    void handleMcpRequest(request, response, services);
  });

  app.get("/mcp", (_request, response) => {
    response.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Method not allowed" },
    });
  });

  app.delete("/mcp", (_request, response) => {
    response.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Method not allowed" },
    });
  });
}
