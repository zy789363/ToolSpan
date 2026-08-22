import { Readable, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  runDesktopHost,
  type DesktopHostOptions,
  type DesktopHostService,
} from "../src/desktop-host/host.js";
import { SERVICE_INFO } from "../src/service-info.js";

async function exchange(
  messages: readonly unknown[],
  service: DesktopHostService,
  hostOptions: Partial<Pick<DesktopHostOptions, "requestTimeoutMs" | "maxMessageBytes">> = {},
): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      stdout += chunk.toString("utf8");
      callback();
    },
  });
  const errorOutput = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      stderr += chunk.toString("utf8");
      callback();
    },
  });
  const input = Readable.from(messages.map((message) => `${JSON.stringify(message)}\n`));

  await runDesktopHost({ input, output, errorOutput, service, ...hostOptions });

  return { stdout, stderr };
}

async function exchangeRaw(
  lines: readonly string[],
  service: DesktopHostService,
): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      stdout += chunk.toString("utf8");
      callback();
    },
  });
  const errorOutput = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      stderr += chunk.toString("utf8");
      callback();
    },
  });
  await runDesktopHost({
    input: Readable.from(lines.map((line) => `${line}\n`)),
    output,
    errorOutput,
    service,
  });
  return { stdout, stderr };
}

const unusedService: DesktopHostService = {
  async invoke() {
    throw new Error("The hello handshake must not invoke the runtime service");
  },
};

function setupManifest(): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    toolSpanVersion: SERVICE_INFO.version,
    instanceName: "Desktop",
    localUrl: "http://127.0.0.1:8787",
    desiredHostname: "mcp.example.test",
    publicMcpUrl: "https://mcp.example.test/mcp",
    oauthDiscoveryUrl: "https://mcp.example.test/.well-known/oauth-authorization-server",
    expectedToolCount: 27,
    tunnelName: "toolspan-test",
    domainChoice: "existing",
    officialDocs: ["https://developers.cloudflare.com/"],
    generatedAt: "2026-08-21T00:00:00.000Z",
  };
}

describe("Desktop Host JSONL protocol", () => {
  it("negotiates protocol v1 without writing logs to stdout", async () => {
    const result = await exchange([
      { id: "hello-1", method: "system.hello", params: { protocolVersion: 1 } },
    ], unusedService);

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${JSON.stringify({
      id: "hello-1",
      ok: true,
      result: {
        protocolVersion: 1,
        productVersion: SERVICE_INFO.version,
        capabilities: ["runtime", "connection", "jobs", "artifacts", "logs", "setup"],
      },
    })}\n`);
  });

  it("rejects an incompatible protocol version and accepts the next hello", async () => {
    const result = await exchange([
      { id: "wrong-version", method: "system.hello", params: { protocolVersion: 2 } },
      { id: "hello-1", method: "system.hello", params: { protocolVersion: 1 } },
    ], unusedService);
    const messages = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);

    expect(messages).toEqual([
      {
        id: "wrong-version",
        ok: false,
        error: {
          code: "PROTOCOL_VERSION_MISMATCH",
          message: "Desktop protocol version 1 is required",
        },
      },
      {
        id: "hello-1",
        ok: true,
        result: {
          protocolVersion: 1,
          productVersion: SERVICE_INFO.version,
          capabilities: ["runtime", "connection", "jobs", "artifacts", "logs", "setup"],
        },
      },
    ]);
  });

  it("reports a product version mismatch explicitly", async () => {
    const result = await exchange([
      {
        id: "wrong-product",
        method: "system.hello",
        params: { protocolVersion: 1, productVersion: "999.0.0" },
      },
    ], unusedService);

    expect(JSON.parse(result.stdout) as unknown).toEqual({
      id: "wrong-product",
      ok: false,
      error: {
        code: "PRODUCT_VERSION_MISMATCH",
        message: `Desktop product version ${SERVICE_INFO.version} is required`,
      },
    });
  });

  it("requires a successful hello before runtime methods", async () => {
    const result = await exchange([
      { id: "snapshot-before-hello", method: "runtime.getSnapshot", params: {} },
      { id: "hello-1", method: "system.hello", params: { protocolVersion: 1 } },
      { id: "snapshot-after-hello", method: "runtime.getSnapshot", params: {} },
    ], {
      async invoke(method, params) {
        expect(method).toBe("runtime.getSnapshot");
        expect(params).toEqual({});
        return { state: "stopped" };
      },
    });

    expect(result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown))
      .toEqual([
        {
          id: "snapshot-before-hello",
          ok: false,
          error: {
            code: "HANDSHAKE_REQUIRED",
            message: "system.hello must complete before other methods",
          },
        },
        {
          id: "hello-1",
          ok: true,
          result: {
            protocolVersion: 1,
            productVersion: SERVICE_INFO.version,
            capabilities: ["runtime", "connection", "jobs", "artifacts", "logs", "setup"],
          },
        },
        { id: "snapshot-after-hello", ok: true, result: { state: "stopped" } },
      ]);
  });

  it("rejects unknown methods and continues serving the session", async () => {
    const invoked: string[] = [];
    const result = await exchange([
      { id: "hello-1", method: "system.hello", params: { protocolVersion: 1 } },
      { id: "unknown-1", method: "runtime.runShell", params: {} },
      { id: "snapshot-1", method: "runtime.getSnapshot", params: {} },
    ], {
      async invoke(method) {
        invoked.push(method);
        return { state: "stopped" };
      },
    });
    const messages = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as {
      id: string;
      error?: { code: string };
    });

    expect(messages[1]).toEqual({
      id: "unknown-1",
      ok: false,
      error: { code: "UNKNOWN_METHOD", message: "Method is not available" },
    });
    expect(messages[2]).toEqual({
      id: "snapshot-1",
      ok: true,
      result: { state: "stopped" },
    });
    expect(invoked).toEqual(["runtime.getSnapshot"]);
  });

  it("validates method parameters before invoking the service", async () => {
    const invoked: string[] = [];
    const result = await exchange([
      { id: "hello-1", method: "system.hello", params: { protocolVersion: 1 } },
      { id: "cancel-invalid", method: "runtime.cancelJob", params: {} },
      { id: "cancel-valid", method: "runtime.cancelJob", params: { jobId: "job-1" } },
    ], {
      async invoke(method) {
        invoked.push(method);
        return { id: "job-1", status: "cancelled" };
      },
    });
    const messages = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);

    expect(messages.slice(1)).toEqual([
      {
        id: "cancel-invalid",
        ok: false,
        error: { code: "INVALID_PARAMS", message: "Method parameters are invalid" },
      },
      {
        id: "cancel-valid",
        ok: true,
        result: { id: "job-1", status: "cancelled" },
      },
    ]);
    expect(invoked).toEqual(["runtime.cancelJob"]);
  });

  it("allows only the frozen setup credential request shape and never echoes the secret", async () => {
    const secret = "fixture-cloudflare-secret";
    const invoked: unknown[] = [];
    const result = await exchange([
      { id: "hello-1", method: "system.hello", params: { protocolVersion: 1 } },
      {
        id: "setup-invalid",
        method: "setup.apply",
        params: {
          sessionId: "setup-session-001",
          confirmation: "APPLY",
          credential: { kind: "api_token", token: secret },
          remember: true,
        },
      },
      {
        id: "setup-apply",
        method: "setup.apply",
        params: {
          sessionId: "setup-session-001",
          confirmation: "APPLY",
          credential: { kind: "api_token", token: secret },
        },
      },
    ], {
      async invoke(method, params) {
        invoked.push({ method, params });
        return {
          setupProtocolVersion: "1",
          sessionId: "setup-session-001",
          status: "COMPLETE",
          requiresCredential: false,
        };
      },
    });
    const messages = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);

    expect(messages[1]).toMatchObject({
      id: "setup-invalid",
      ok: false,
      error: { code: "INVALID_PARAMS" },
    });
    expect(messages[2]).toMatchObject({
      id: "setup-apply",
      ok: true,
      result: { status: "COMPLETE" },
    });
    expect(invoked).toEqual([{
      method: "setup.apply",
      params: {
        sessionId: "setup-session-001",
        confirmation: "APPLY",
        credential: { kind: "api_token", token: secret },
      },
    }]);
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });

  it("keeps zone and session identifiers outside the exportable safe manifest", async () => {
    const validManifest = setupManifest();
    const { oauthDiscoveryUrl: _oauthDiscoveryUrl, ...legacyManifest } = validManifest;
    const result = await exchange([
      { id: "hello-1", method: "system.hello", params: { protocolVersion: 1 } },
      {
        id: "embedded-zone",
        method: "setup.preflight",
        params: {
          sessionId: "setup-session-001",
          idempotencyKey: "idempotency-001",
          zoneName: "example.test",
          manifest: { ...validManifest, zoneName: "example.test" },
          credential: { kind: "api_token", token: "fixture-secret" },
        },
      },
      {
        id: "legacy-oauth-field",
        method: "setup.preflight",
        params: {
          sessionId: "setup-session-001",
          idempotencyKey: "idempotency-001",
          zoneName: "example.test",
          manifest: {
            ...legacyManifest,
            oauthUrl: "https://mcp.example.test/.well-known/oauth-authorization-server",
          },
          credential: { kind: "api_token", token: "fixture-secret" },
        },
      },
      {
        id: "valid-preflight",
        method: "setup.preflight",
        params: {
          sessionId: "setup-session-001",
          idempotencyKey: "idempotency-001",
          zoneName: "example.test",
          manifest: validManifest,
          credential: { kind: "api_token", token: "fixture-secret" },
        },
      },
    ], {
      async invoke() {
        return { status: "PREFLIGHT", requiresCredential: false };
      },
    });
    const messages = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);

    expect(messages[1]).toMatchObject({
      id: "embedded-zone",
      ok: false,
      error: { code: "INVALID_PARAMS" },
    });
    expect(messages[2]).toMatchObject({
      id: "legacy-oauth-field",
      ok: false,
      error: { code: "INVALID_PARAMS" },
    });
    expect(messages[3]).toMatchObject({
      id: "valid-preflight",
      ok: true,
      result: { status: "PREFLIGHT" },
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain("fixture-secret");
  });

  it("rejects a reused request id without ending the session", async () => {
    const result = await exchange([
      { id: "same-id", method: "system.hello", params: { protocolVersion: 1 } },
      { id: "same-id", method: "runtime.getSnapshot", params: {} },
      { id: "new-id", method: "runtime.getSnapshot", params: {} },
    ], {
      async invoke() {
        return { state: "stopped" };
      },
    });
    const messages = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);

    expect(messages.slice(1)).toEqual([
      {
        id: "same-id",
        ok: false,
        error: { code: "DUPLICATE_REQUEST_ID", message: "Request id has already been used" },
      },
      { id: "new-id", ok: true, result: { state: "stopped" } },
    ]);
  });

  it("reports malformed JSON and accepts the following request", async () => {
    const result = await exchangeRaw([
      "{not-json",
      JSON.stringify({ id: "hello-1", method: "system.hello", params: { protocolVersion: 1 } }),
    ], unusedService);
    const messages = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);

    expect(messages[0]).toEqual({
      id: null,
      ok: false,
      error: { code: "INVALID_MESSAGE", message: "Message must be valid protocol JSON" },
    });
    expect(messages[1]).toMatchObject({ id: "hello-1", ok: true });
  });

  it("validates the request envelope before reserving its id", async () => {
    const result = await exchange([
      { id: "hello-1", method: 7, params: {} },
      { id: "hello-1", method: "system.hello", params: { protocolVersion: 1 } },
    ], unusedService);
    const messages = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);

    expect(messages[0]).toEqual({
      id: "hello-1",
      ok: false,
      error: { code: "INVALID_MESSAGE", message: "Message does not match the protocol" },
    });
    expect(messages[1]).toMatchObject({ id: "hello-1", ok: true });
  });

  it("rejects an oversized line and continues at the next JSONL boundary", async () => {
    const result = await exchange([
      {
        id: "oversized",
        method: "system.hello",
        params: { protocolVersion: 1, productVersion: "x".repeat(256) },
      },
      { id: "hello-1", method: "system.hello", params: { protocolVersion: 1 } },
    ], unusedService, { maxMessageBytes: 128 });
    const messages = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);

    expect(messages[0]).toEqual({
      id: null,
      ok: false,
      error: { code: "MESSAGE_TOO_LARGE", message: "Message exceeds the 1 MiB limit" },
    });
    expect(messages[1]).toMatchObject({ id: "hello-1", ok: true });
  });

  it("times out a stuck invocation and serves the next request", async () => {
    let invocation = 0;
    const result = await exchange([
      { id: "hello-1", method: "system.hello", params: { protocolVersion: 1 } },
      { id: "stuck", method: "runtime.getSnapshot", params: {} },
      { id: "recovered", method: "runtime.getSnapshot", params: {} },
    ], {
      async invoke() {
        invocation += 1;
        if (invocation === 1) return new Promise<never>(() => undefined);
        return { state: "stopped" };
      },
    }, { requestTimeoutMs: 10 });
    const messages = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);

    expect(messages.slice(1)).toEqual([
      {
        id: "stuck",
        ok: false,
        error: { code: "REQUEST_TIMEOUT", message: "Desktop host request timed out" },
      },
      { id: "recovered", ok: true, result: { state: "stopped" } },
    ]);
  });

  it("contains a service crash without exposing its error or ending the session", async () => {
    let invocation = 0;
    const result = await exchange([
      { id: "hello-1", method: "system.hello", params: { protocolVersion: 1 } },
      { id: "crashed", method: "runtime.getSnapshot", params: {} },
      { id: "recovered", method: "runtime.getSnapshot", params: {} },
    ], {
      async invoke() {
        invocation += 1;
        if (invocation === 1) throw new Error("Authorization: Bearer must-not-leak");
        return { state: "stopped" };
      },
    });
    const messages = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);

    expect(messages.slice(1)).toEqual([
      {
        id: "crashed",
        ok: false,
        error: { code: "SERVICE_ERROR", message: "Desktop host operation failed" },
      },
      { id: "recovered", ok: true, result: { state: "stopped" } },
    ]);
    expect(`${result.stdout}${result.stderr}`).not.toContain("must-not-leak");
  });

  it("emits subscribed events as messages distinct from responses", async () => {
    let publish: ((event: { event: "runtime.snapshot"; data: unknown }) => void) | undefined;
    const service: DesktopHostService = {
      async invoke(method) {
        if (method === "runtime.subscribeEvents") return { subscribed: true };
        publish?.({ event: "runtime.snapshot", data: { state: "running" } });
        return { state: "running" };
      },
      subscribeEvents(listener) {
        publish = listener;
        return () => {
          publish = undefined;
        };
      },
    };
    const result = await exchange([
      { id: "hello-1", method: "system.hello", params: { protocolVersion: 1 } },
      { id: "subscribe-1", method: "runtime.subscribeEvents", params: { enabled: true } },
      { id: "snapshot-1", method: "runtime.getSnapshot", params: {} },
    ], service);
    const messages = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);

    expect(messages.slice(1)).toEqual([
      { id: "subscribe-1", ok: true, result: { subscribed: true } },
      { event: "runtime.snapshot", data: { state: "running" } },
      { id: "snapshot-1", ok: true, result: { state: "running" } },
    ]);
    expect(publish).toBeUndefined();
  });
});
