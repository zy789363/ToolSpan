import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { hash } from "bcryptjs";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createOAuthService } from "../src/auth/oauth-service.js";
import { createHttpApp } from "../src/http-app.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createFixture(instanceName?: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "webgpt-oauth-"));
  temporaryDirectories.push(directory);
  const oauth = createOAuthService({
    databasePath: path.join(directory, "state.sqlite"),
    issuer: "https://mcp.example.test",
    resource: "https://mcp.example.test/mcp",
    ownerPasswordHash: await hash("owner-password", 4),
  });
  return { oauth, app: createHttpApp({ oauth, instanceName }) };
}

describe("OAuth 2.1 server", () => {
  it("advertises resource and authorization metadata and validates DCR redirects", async () => {
    const { app, oauth } = await createFixture();
    try {
      await request(app)
        .get("/.well-known/oauth-protected-resource")
        .expect(200)
        .expect(({ body }) => {
          expect(body).toEqual(
            expect.objectContaining({
              resource: "https://mcp.example.test/mcp",
              authorization_servers: ["https://mcp.example.test"],
              scopes_supported: [
                "workspace:read",
                "workspace:write",
                "jobs:run",
                "artifacts:publish",
                "offline_access",
              ],
            }),
          );
        });
      await request(app)
        .get("/.well-known/oauth-authorization-server")
        .expect(200)
        .expect(({ body }) => {
          expect(body.code_challenge_methods_supported).toEqual(["S256"]);
          expect(body.registration_endpoint).toBe("https://mcp.example.test/oauth/register");
          expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
          expect(body.scopes_supported).toEqual([
            "workspace:read",
            "workspace:write",
            "jobs:run",
            "artifacts:publish",
            "offline_access",
          ]);
        });

      await request(app)
        .post("/oauth/register")
        .send({ client_name: "bad", redirect_uris: ["http://attacker.example/callback"] })
        .expect(400);
      await request(app)
        .post("/oauth/register")
        .send({
          client_name: "implicit client",
          redirect_uris: ["https://client.example/callback"],
          response_types: ["token"],
        })
        .expect(400);
      await request(app)
        .post("/oauth/register")
        .send({
          client_name: "Codex test",
          redirect_uris: ["http://127.0.0.1:4567/callback"],
          token_endpoint_auth_method: "none",
        })
        .expect(201)
        .expect(({ body }) => {
          expect(body.client_id).toEqual(expect.any(String));
          expect(body.client_secret).toBeUndefined();
        });
    } finally {
      oauth.close();
    }
  });

  it("allows the registered callback origin in the authorization form CSP", async () => {
    const { app, oauth } = await createFixture();
    try {
      const registered = await request(app).post("/oauth/register").send({
        client_name: "ChatGPT",
        redirect_uris: ["https://chatgpt.com/connector/oauth/test"],
        token_endpoint_auth_method: "none",
      });

      await request(app)
        .get("/oauth/authorize")
        .query({
          response_type: "code",
          client_id: registered.body.client_id,
          redirect_uri: "https://chatgpt.com/connector/oauth/test",
          scope: "workspace:read",
          state: "opaque-state",
          code_challenge: "A".repeat(43),
          code_challenge_method: "S256",
          resource: "https://mcp.example.test/mcp",
        })
        .expect(200)
        .expect(
          "Content-Security-Policy",
          "default-src 'none'; form-action 'self' https://chatgpt.com; base-uri 'none'; frame-ancestors 'none'",
        );
    } finally {
      oauth.close();
    }
  });

  it("accepts legal Host ports but rejects userinfo and malformed authorities", async () => {
    const app = createHttpApp({ allowedHosts: ["trusted.example"] });

    await request(app)
      .get("/healthz")
      .set("Host", "trusted.example:8443")
      .expect(200);
    await request(app)
      .get("/healthz")
      .set("Host", "evil.example@trusted.example")
      .expect(403);
    await request(app)
      .get("/healthz")
      .set("Host", "trusted.example/path")
      .expect(403);
    await request(app)
      .get("/healthz")
      .set("Host", "trusted.example:not-a-port")
      .expect(403);
  });

  it("shows the escaped client, redirect origin, and only the requested scopes", async () => {
    const { app, oauth } = await createFixture();
    try {
      const clientName = '<script>alert("client")</script>';
      const redirectUri = 'https://client.example/callback?return="><script>alert("redirect")</script>';
      const registered = await request(app).post("/oauth/register").send({
        client_name: clientName,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      });

      const response = await request(app)
        .get("/oauth/authorize")
        .query({
          response_type: "code",
          client_id: registered.body.client_id,
          redirect_uri: redirectUri,
          scope: "workspace:read",
          state: 'opaque"><script>alert("state")</script>',
          code_challenge: "A".repeat(43),
          code_challenge_method: "S256",
          resource: "https://mcp.example.test/mcp",
        })
        .expect(200);

      expect(response.text).toContain("Authorize ToolSpan access");
      expect(response.text).toContain("&lt;script&gt;alert(&quot;client&quot;)&lt;/script&gt;");
      expect(response.text).toContain("Redirect origin: <code>https://client.example</code>");
      expect(response.text).toContain("<li><code>workspace:read</code>");
      expect(response.text).not.toContain("<li><code>workspace:write</code>");
      expect(response.text).not.toContain("<li><code>jobs:run</code>");
      expect(response.text).not.toContain("<li><code>artifacts:publish</code>");
      expect(response.text).not.toContain(clientName);
      expect(response.text).not.toContain(redirectUri);
      expect(response.text).not.toContain('<script>alert("state")</script>');
      expect(response.text).not.toContain("ToolSpan instance:");
    } finally {
      oauth.close();
    }
  });

  it("shows an escaped configured ToolSpan instance name", async () => {
    const instanceName = '<script>alert("instance")</script>';
    const { app, oauth } = await createFixture(instanceName);
    try {
      const registered = await request(app).post("/oauth/register").send({
        client_name: "Instance client",
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "none",
      });

      const response = await request(app)
        .get("/oauth/authorize")
        .query({
          response_type: "code",
          client_id: registered.body.client_id,
          redirect_uri: "https://client.example/callback",
          scope: "workspace:read",
          code_challenge: "A".repeat(43),
          code_challenge_method: "S256",
          resource: "https://mcp.example.test/mcp",
        })
        .expect(200);

      expect(response.text).toContain(
        "ToolSpan instance: <strong>&lt;script&gt;alert(&quot;instance&quot;)&lt;/script&gt;</strong>",
      );
      expect(response.text).not.toContain(instanceName);
    } finally {
      oauth.close();
    }
  });

  it("rejects an unknown scope before rendering consent", async () => {
    const { app, oauth } = await createFixture();
    try {
      const registered = await request(app).post("/oauth/register").send({
        client_name: "Unknown scope client",
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "none",
      });

      await request(app)
        .get("/oauth/authorize")
        .query({
          response_type: "code",
          client_id: registered.body.client_id,
          redirect_uri: "https://client.example/callback",
          scope: 'workspace:read unknown"><script>alert(1)</script>',
          code_challenge: "A".repeat(43),
          code_challenge_method: "S256",
          resource: "https://mcp.example.test/mcp",
        })
        .expect(400)
        .expect("Content-Type", /json/)
        .expect(({ body }) => {
          expect(body).toEqual({
            error: "invalid_scope",
            error_description: "One or more scopes are not supported",
          });
        });
    } finally {
      oauth.close();
    }
  });

  it("explains a requested high-risk scope without showing unrequested permissions", async () => {
    const { app, oauth } = await createFixture();
    try {
      const registered = await request(app).post("/oauth/register").send({
        client_name: "Write client",
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "none",
      });

      const response = await request(app)
        .get("/oauth/authorize")
        .query({
          response_type: "code",
          client_id: registered.body.client_id,
          redirect_uri: "https://client.example/callback",
          scope: "workspace:write",
          code_challenge: "A".repeat(43),
          code_challenge_method: "S256",
          resource: "https://mcp.example.test/mcp",
        })
        .expect(200);

      expect(response.text).toContain("Create, modify, move, and delete workspace files.");
      expect(response.text).toContain("<strong>High risk:</strong>");
      expect(response.text).toContain("This permission can change or remove workspace data.");
      expect(response.text).not.toContain("Read workspace, file, job, and artifact information.");
      expect(response.text).not.toContain("Run allowlisted project tasks.");
      expect(response.text).not.toContain("Publish artifacts through shareable links.");
    } finally {
      oauth.close();
    }
  });

  it("accepts and explains offline_access as a lifecycle scope", async () => {
    const { app, oauth } = await createFixture();
    try {
      const registered = await request(app).post("/oauth/register").send({
        client_name: "Persistent client",
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "none",
      });

      const response = await request(app)
        .get("/oauth/authorize")
        .query({
          response_type: "code",
          client_id: registered.body.client_id,
          redirect_uri: "https://client.example/callback",
          scope: "workspace:read offline_access",
          code_challenge: "A".repeat(43),
          code_challenge_method: "S256",
          resource: "https://mcp.example.test/mcp",
        })
        .expect(200);

      expect(response.text).toContain("<li><code>offline_access</code>");
      expect(response.text).toContain("Maintain access by using refresh tokens.");
      expect(response.text).toContain("This client can stay connected after the current access token expires.");
    } finally {
      oauth.close();
    }
  });

  it("keeps issuing refresh tokens when offline_access is not requested", async () => {
    const { app, oauth } = await createFixture();
    try {
      const registered = await request(app).post("/oauth/register").send({
        client_name: "Codex test",
        redirect_uris: ["http://127.0.0.1:4567/callback"],
        token_endpoint_auth_method: "none",
      });
      const clientId = registered.body.client_id as string;
      const verifier = "test-verifier-that-is-long-enough-for-pkce-0123456789";
      const challenge = Buffer.from(
        await crypto.subtle.digest("SHA-256", Buffer.from(verifier)),
      ).toString("base64url");
      const authorization = {
        response_type: "code",
        client_id: clientId,
        redirect_uri: "http://127.0.0.1:4567/callback",
        scope: "workspace:read workspace:write jobs:run artifacts:publish",
        state: "opaque-state",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: "https://mcp.example.test/mcp",
      };

      await request(app)
        .post("/oauth/authorize")
        .type("form")
        .send({ ...authorization, password: "wrong" })
        .expect(401);
      const approved = await request(app)
        .post("/oauth/authorize")
        .type("form")
        .send({ ...authorization, password: "owner-password" })
        .expect(302);
      const callback = new URL(approved.headers.location as string);
      expect(callback.searchParams.get("state")).toBe("opaque-state");
      const code = callback.searchParams.get("code");
      expect(code).toEqual(expect.any(String));

      await request(app)
        .post("/oauth/token")
        .type("form")
        .send({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: authorization.redirect_uri,
          code_verifier: "too-short",
          resource: authorization.resource,
        })
        .expect(400)
        .expect(({ body }) => expect(body.error).toBe("invalid_grant"));

      const token = await request(app)
        .post("/oauth/token")
        .type("form")
        .send({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: authorization.redirect_uri,
          code_verifier: verifier,
          resource: authorization.resource,
        })
        .expect(200);
      expect(token.body).toEqual(
        expect.objectContaining({
          token_type: "Bearer",
          access_token: expect.any(String),
          refresh_token: expect.any(String),
          scope: authorization.scope,
        }),
      );

      await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "oauth-test", version: "1" },
      } }).expect(401).expect("WWW-Authenticate", /resource_metadata=/);
      await request(app)
        .post("/mcp")
        .set("Authorization", `Bearer ${String(token.body.access_token)}`)
        .set("Accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "oauth-test", version: "1" },
        } })
        .expect(200);

      await request(app)
        .post("/oauth/token")
        .type("form")
        .send({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: authorization.redirect_uri,
          code_verifier: verifier,
          resource: authorization.resource,
        })
        .expect(400)
        .expect(({ body }) => expect(body.error).toBe("invalid_grant"));

      await request(app)
        .post("/oauth/token")
        .type("form")
        .send({
          grant_type: "refresh_token",
          refresh_token: token.body.refresh_token,
          client_id: clientId,
          resource: authorization.resource,
        })
        .expect(200)
        .expect(({ body }) => expect(body.access_token).toEqual(expect.any(String)));
    } finally {
      oauth.close();
    }
  });

  it("rotates refresh tokens while keeping lifecycle scopes out of Tool permissions", async () => {
    const { app, oauth } = await createFixture();
    try {
      const registered = await request(app).post("/oauth/register").send({
        client_name: "Offline client",
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "none",
      });
      const clientId = registered.body.client_id as string;
      const verifier = "offline-verifier-that-is-long-enough-for-pkce-0123456789";
      const challenge = Buffer.from(
        await crypto.subtle.digest("SHA-256", Buffer.from(verifier)),
      ).toString("base64url");
      const authorization = {
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://client.example/callback",
        scope: "workspace:read workspace:write offline_access",
        state: "offline-state",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: "https://mcp.example.test/mcp",
      };

      const approved = await request(app)
        .post("/oauth/authorize")
        .type("form")
        .send({ ...authorization, password: "owner-password" })
        .expect(302);
      const code = new URL(approved.headers.location as string).searchParams.get("code");

      const initial = await request(app)
        .post("/oauth/token")
        .type("form")
        .send({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: authorization.redirect_uri,
          code_verifier: verifier,
          resource: authorization.resource,
        })
        .expect(200);
      expect(initial.body.scope).toBe("workspace:read workspace:write offline_access");
      expect([...oauth.authenticate(`Bearer ${String(initial.body.access_token)}`).scopes]).toEqual([
        "workspace:read",
        "workspace:write",
      ]);

      await request(app)
        .post("/oauth/token")
        .type("form")
        .send({
          grant_type: "refresh_token",
          refresh_token: initial.body.refresh_token,
          client_id: clientId,
          resource: authorization.resource,
          scope: "workspace:read jobs:run",
        })
        .expect(400)
        .expect(({ body }) => expect(body.error).toBe("invalid_scope"));

      await request(app)
        .post("/oauth/token")
        .type("form")
        .send({
          grant_type: "refresh_token",
          refresh_token: initial.body.refresh_token,
          client_id: clientId,
          resource: authorization.resource,
          scope: "workspace:read unknown:scope",
        })
        .expect(400)
        .expect(({ body }) => expect(body.error).toBe("invalid_scope"));

      const preserved = await request(app)
        .post("/oauth/token")
        .type("form")
        .send({
          grant_type: "refresh_token",
          refresh_token: initial.body.refresh_token,
          client_id: clientId,
          resource: authorization.resource,
        })
        .expect(200);
      expect(preserved.body).toEqual(
        expect.objectContaining({
          access_token: expect.any(String),
          refresh_token: expect.any(String),
          scope: authorization.scope,
        }),
      );
      expect(preserved.body.refresh_token).not.toBe(initial.body.refresh_token);
      expect([...oauth.authenticate(`Bearer ${String(preserved.body.access_token)}`).scopes]).toEqual([
        "workspace:read",
        "workspace:write",
      ]);

      const narrowed = await request(app)
        .post("/oauth/token")
        .type("form")
        .send({
          grant_type: "refresh_token",
          refresh_token: preserved.body.refresh_token,
          client_id: clientId,
          resource: authorization.resource,
          scope: "workspace:read",
        })
        .expect(200);
      expect(narrowed.body.scope).toBe("workspace:read");
      expect([...oauth.authenticate(`Bearer ${String(narrowed.body.access_token)}`).scopes]).toEqual([
        "workspace:read",
      ]);

      await request(app)
        .post("/oauth/token")
        .type("form")
        .send({
          grant_type: "refresh_token",
          refresh_token: initial.body.refresh_token,
          client_id: clientId,
          resource: authorization.resource,
        })
        .expect(400)
        .expect(({ body }) => expect(body.error).toBe("invalid_grant"));

      await request(app)
        .post("/oauth/token")
        .type("form")
        .send({
          grant_type: "refresh_token",
          refresh_token: narrowed.body.refresh_token,
          client_id: clientId,
          resource: authorization.resource,
        })
        .expect(200);
    } finally {
      oauth.close();
    }
  });
});
