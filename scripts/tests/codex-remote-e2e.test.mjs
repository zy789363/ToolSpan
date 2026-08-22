import assert from "node:assert/strict";
import test from "node:test";

import {
  extractCodexAuthorizationUrl,
  extractQuickTunnelUrl,
  quickTunnelArguments,
  summarizeCodexJsonEvents,
} from "../e2e-codex-remote.mjs";

test("Quick Tunnel forces HTTP2 when the environment blocks QUIC", () => {
  assert.deepEqual(quickTunnelArguments("http://127.0.0.1:8787"), [
    "tunnel",
    "--url",
    "http://127.0.0.1:8787",
    "--no-autoupdate",
    "--protocol",
    "http2",
  ]);
});

test("Quick Tunnel URL extraction accepts only credential-free trycloudflare HTTPS origins", () => {
  const output = "Your quick Tunnel has started: https://safe-random-name.trycloudflare.com";
  assert.equal(extractQuickTunnelUrl(output)?.href, "https://safe-random-name.trycloudflare.com/");
  assert.equal(extractQuickTunnelUrl("https://example.com"), undefined);
  assert.equal(extractQuickTunnelUrl("https://user:pass@unsafe.trycloudflare.com"), undefined);
});

test("Codex OAuth URL extraction requires the expected ToolSpan origin and loopback callback", () => {
  const origin = "https://safe-random-name.trycloudflare.com";
  const authorization = new URL("/oauth/authorize", origin);
  authorization.search = new URLSearchParams({
    response_type: "code",
    client_id: "synthetic-codex-client",
    redirect_uri: "http://127.0.0.1:43124/callback",
    scope: "workspace:read workspace:write jobs:run artifacts:publish",
    state: "synthetic-state",
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  }).toString();
  assert.equal(extractCodexAuthorizationUrl(`Open: ${authorization.href}`, origin)?.href, authorization.href);
  assert.equal(extractCodexAuthorizationUrl(`Open: ${authorization.href}`, "https://other.trycloudflare.com"), undefined);
});

test("Codex JSON event summary keeps MCP identity while dropping arguments and local content", () => {
  const events = [
    { type: "item.started", item: { type: "mcp_tool_call", server: "toolspan_e2e_test", tool: "read", arguments: { path: "private" } } },
    { type: "item.completed", item: { type: "mcp_tool_call", server: "toolspan_e2e_test", tool: "read", status: "completed", result: "private content" } },
    { type: "item.completed", item: { type: "command_execution", command: "should-not-run" } },
  ];
  assert.deepEqual(summarizeCodexJsonEvents(events, "toolspan_e2e_test"), {
    mcpCalls: [
      { server: "toolspan_e2e_test", tool: "read", phase: "started" },
      { server: "toolspan_e2e_test", tool: "read", phase: "completed" },
    ],
    localExecutionCount: 1,
  });
});
