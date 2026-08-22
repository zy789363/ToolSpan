import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import request from "supertest";
import { hash } from "bcryptjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { createArtifactService } from "../src/artifacts/artifact-service.js";
import { createOAuthService } from "../src/auth/oauth-service.js";
import { createFileService } from "../src/files/file-service.js";
import { createHttpApp } from "../src/http-app.js";
import { createJobService } from "../src/jobs/job-service.js";
import { createMcpServer } from "../src/mcp.js";
import { createWorkspaceService } from "../src/workspaces/workspace-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createFixture(withOAuth = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "webgpt-mcp-tools-"));
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
    previewSecret: Buffer.alloc(32, 4),
  });
  const oauth = withOAuth ? createOAuthService({
    databasePath,
    issuer: "https://mcp.example.test",
    resource: "https://mcp.example.test/mcp",
    ownerPasswordHash: await hash("owner-password", 4),
  }) : undefined;
  const mcp = {
    workspaces,
    files,
    jobs,
    artifacts,
    runnerNames: [],
    startedAt: Date.now(),
    protectedResourceMetadataUrl: "https://mcp.example.test/.well-known/oauth-protected-resource",
  };
  const app = createHttpApp({
    oauth,
    mcp,
  });
  return {
    app,
    mcp,
    project,
    async close() {
      artifacts.close();
      await jobs.close();
      oauth?.close();
      workspaces.close();
    },
  };
}

function rpc(app: ReturnType<typeof createHttpApp>, body: Record<string, unknown>) {
  return request(app)
    .post("/mcp")
    .set("Accept", "application/json, text/event-stream")
    .set("Content-Type", "application/json")
    .send(body);
}

describe("MCP tools", () => {
  it("negotiates 2025-11-25 and completes initialize, tools/list, and tools/call", async () => {
    const fixture = await createFixture();
    const httpServer = fixture.app.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address() as AddressInfo;
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${String(address.port)}/mcp`),
    );
    const client = new Client({ name: "mcp-integration-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect(transport.protocolVersion).toBe("2025-11-25");

      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(27);

      const opened = await client.callTool({
        name: "open_workspace",
        arguments: { path: fixture.project },
      });
      expect(opened.isError).not.toBe(true);
      expect(opened.structuredContent).toMatchObject({ id: expect.any(String) });
    } finally {
      await client.close();
      httpServer.close();
      await once(httpServer, "close");
      await fixture.close();
    }
  });

  it("owns the complete runtime tool registry without relying on SDK internals", async () => {
    const fixture = await createFixture();
    try {
      const runtime = createMcpServer(fixture.mcp);
      expect(runtime.registry.entries()).toHaveLength(27);
      expect(runtime.registry.entries()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "read",
          requiredScopes: ["workspace:read"],
          securitySchemes: [{ type: "oauth2", scopes: ["workspace:read"] }],
          handler: expect.any(Function),
        }),
        expect.objectContaining({
          name: "write",
          requiredScopes: ["workspace:write"],
          securitySchemes: [{ type: "oauth2", scopes: ["workspace:write"] }],
          handler: expect.any(Function),
        }),
      ]));
    } finally {
      await fixture.close();
    }
  });

  it("advertises exactly the contracted 27 tools with safety and OAuth metadata", async () => {
    const fixture = await createFixture();
    try {
      const response = await rpc(fixture.app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }).expect(200);
      const tools = response.body.result.tools as Array<Record<string, unknown>>;
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "apply_patch", "cancel_job", "copy_path", "delete_path", "devspace_info", "edit",
        "import_asset", "inspect_artifact", "list_artifacts", "list_directory", "list_jobs",
        "list_workspaces", "make_directory", "move_path", "open_workspace", "poll_job",
        "preview_artifact", "publish_artifact", "read", "read_many", "restore_path",
        "resume_workspace", "search_files", "start_capture", "start_job", "stat_path", "write",
      ]);
      expect(tools.find((tool) => tool.name === "read")).toMatchObject({
        annotations: { readOnlyHint: true, destructiveHint: false },
        securitySchemes: [{ type: "oauth2", scopes: ["workspace:read"] }],
        _meta: { securitySchemes: [{ type: "oauth2", scopes: ["workspace:read"] }] },
      });
      expect(tools.find((tool) => tool.name === "write")).toMatchObject({
        annotations: { readOnlyHint: false, destructiveHint: true },
        _meta: { securitySchemes: [{ type: "oauth2", scopes: ["workspace:write"] }] },
      });
      expect(tools.find((tool) => tool.name === "list_directory")).toMatchObject({
        annotations: { readOnlyHint: true, destructiveHint: false },
        securitySchemes: [{ type: "oauth2", scopes: ["workspace:read"] }],
      });
      expect(tools.find((tool) => tool.name === "delete_path")).toMatchObject({
        annotations: { readOnlyHint: false, destructiveHint: true },
        securitySchemes: [{ type: "oauth2", scopes: ["workspace:write"] }],
      });
      expect(tools.find((tool) => tool.name === "make_directory")).toMatchObject({
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      });
    } finally {
      await fixture.close();
    }
  });

  it("opens a workspace and performs file calls through the MCP boundary", async () => {
    const fixture = await createFixture();
    try {
      const opened = await rpc(fixture.app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "open_workspace", arguments: { path: fixture.project } },
      }).expect(200);
      const workspaceId = opened.body.result.structuredContent.id as string;
      expect(workspaceId).toEqual(expect.any(String));

      await rpc(fixture.app, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "write",
          arguments: { workspaceId, path: "hello.txt", content: "updated\n" },
        },
      }).expect(200).expect(({ body }) => expect(body.result.isError).not.toBe(true));
      await rpc(fixture.app, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "read", arguments: { workspaceId, path: "hello.txt" } },
      }).expect(200).expect(({ body }) => {
        expect(body.result.structuredContent.lines).toEqual(["updated", ""]);
      });
      await rpc(fixture.app, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "make_directory",
          arguments: { workspaceId, path: "src/nested" },
        },
      }).expect(200).expect(({ body }) => {
        expect(body.result.structuredContent).toMatchObject({ path: "src/nested", created: true });
      });
      await rpc(fixture.app, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "list_directory",
          arguments: { workspaceId, path: ".", depth: 2 },
        },
      }).expect(200).expect(({ body }) => {
        expect(body.result.structuredContent.entries).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: "src/nested", type: "directory" }),
        ]));
      });
    } finally {
      await fixture.close();
    }
  });

  it("returns a tool-level OAuth challenge when the token lacks the required scope", async () => {
    const fixture = await createFixture(true);
    try {
      const registered = await request(fixture.app).post("/oauth/register").send({
        client_name: "scope test",
        redirect_uris: ["http://127.0.0.1:4567/callback"],
        token_endpoint_auth_method: "none",
      });
      const verifier = "scope-test-verifier-that-is-long-enough-0123456789";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const approved = await request(fixture.app).post("/oauth/authorize").type("form").send({
        response_type: "code",
        client_id: registered.body.client_id,
        redirect_uri: "http://127.0.0.1:4567/callback",
        scope: "workspace:read",
        state: "scope-state",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: "https://mcp.example.test/mcp",
        password: "owner-password",
      });
      const code = new URL(approved.headers.location as string).searchParams.get("code");
      const token = await request(fixture.app).post("/oauth/token").type("form").send({
        grant_type: "authorization_code",
        code,
        client_id: registered.body.client_id,
        redirect_uri: "http://127.0.0.1:4567/callback",
        code_verifier: verifier,
        resource: "https://mcp.example.test/mcp",
      });

      await request(fixture.app)
        .post("/mcp")
        .set("Authorization", `Bearer ${String(token.body.access_token)}`)
        .set("Accept", "application/json, text/event-stream")
        .send({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: {
            name: "write",
            arguments: {
              workspaceId: "00000000-0000-4000-8000-000000000000",
              path: "blocked.txt",
              content: "blocked",
            },
          },
        })
        .expect(200)
        .expect(({ body }) => {
          expect(body.result).toMatchObject({
            isError: true,
            _meta: { "mcp/www_authenticate": [expect.stringContaining("insufficient_scope")] },
          });
        });
      await request(fixture.app)
        .post("/mcp")
        .set("Authorization", `Bearer ${String(token.body.access_token)}`)
        .set("Accept", "application/json, text/event-stream")
        .send({
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: {
            name: "make_directory",
            arguments: {
              workspaceId: "00000000-0000-4000-8000-000000000000",
              path: "blocked",
            },
          },
        })
        .expect(200)
        .expect(({ body }) => {
          expect(body.result).toMatchObject({
            isError: true,
            _meta: { "mcp/www_authenticate": [expect.stringContaining("insufficient_scope")] },
          });
        });
    } finally {
      await fixture.close();
    }
  });
});
