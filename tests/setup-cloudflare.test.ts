import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CLOUDFLARE_API_ORIGIN,
  CloudflareApiError,
  CloudflareConcurrencyError,
  CloudflareOutcomeUnknownError,
  createCloudflareFetchAdapter,
  type CloudflareLogEvent,
} from "../src/setup/cloudflare-fetch-adapter.js";
import {
  CloudflaredManualCheckpointError,
  createManualCloudflaredAdapter,
} from "../src/setup/cloudflared-adapter.js";
import { createLocalCloudflaredAdapter } from "../src/setup/local-cloudflared-adapter.js";

const apiCredential = { kind: "api_token" as const, token: "fake-api-token-value" };

function testFingerprint(value: unknown): string {
  return createHash("sha256").update(testStableJson(value)).digest("hex");
}

function testStableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(testStableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${testStableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function cloudflareResponse(
  result: unknown,
  options: {
    status?: number;
    success?: boolean;
    errors?: unknown[];
    resultInfo?: { page: number; total_pages: number };
    headers?: Record<string, string>;
  } = {},
): Response {
  return new Response(
    JSON.stringify({
      success: options.success ?? true,
      result,
      errors: options.errors ?? [],
      ...(options.resultInfo === undefined ? {} : { result_info: options.resultInfo }),
    }),
    {
      status: options.status ?? 200,
      headers: { "content-type": "application/json", ...options.headers },
    },
  );
}

describe("Cloudflare fetch adapter", () => {
  it("uses only the fixed api.cloudflare.com origin with API Token auth", async () => {
    const events: CloudflareLogEvent[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      cloudflareResponse({ status: "active" }),
    );
    const adapter = createCloudflareFetchAdapter({
      fetch: fetchMock as typeof fetch,
      logger: (event) => events.push(event),
    });

    await adapter.verifyCredential({ credential: apiCredential });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${CLOUDFLARE_API_ORIGIN}/client/v4/user/tokens/verify`);
    expect((init?.headers as Headers).get("Authorization")).toBe(`Bearer ${apiCredential.token}`);
    expect(init?.redirect).toBe("error");
    expect(JSON.stringify(events)).not.toContain(apiCredential.token);
    expect(events).toEqual([
      expect.objectContaining({ method: "GET", path: "/user/tokens/verify", outcome: "request" }),
      expect.objectContaining({ method: "GET", path: "/user/tokens/verify", outcome: "success" }),
    ]);
  });

  it("preserves Cloudflare pagination metadata and query parameters", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      cloudflareResponse([{ id: "account-2", name: "Second" }], {
        resultInfo: { page: 2, total_pages: 3 },
      }),
    );
    const adapter = createCloudflareFetchAdapter({ fetch: fetchMock as typeof fetch });

    await expect(
      adapter.listAccounts({ credential: apiCredential, page: 2, perPage: 50 }),
    ).resolves.toEqual({
      items: [{ id: "account-2", name: "Second" }],
      page: 2,
      totalPages: 3,
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `${CLOUDFLARE_API_ORIGIN}/client/v4/accounts?page=2&per_page=50`,
    );
  });

  it("surfaces a typed Cloudflare error envelope without credential leakage", async () => {
    const events: CloudflareLogEvent[] = [];
    const adapter = createCloudflareFetchAdapter({
      fetch: vi.fn(async () =>
        cloudflareResponse(null, {
          status: 403,
          success: false,
          errors: [{ code: 9109, message: `invalid bearer ${apiCredential.token}` }],
        }),
      ) as typeof fetch,
      logger: (event) => events.push(event),
    });

    const error = await adapter.listAccounts({ credential: apiCredential }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as Error).message).not.toContain(apiCredential.token);
    expect(JSON.stringify(events)).not.toContain(apiCredential.token);
  });

  it("retries a rate-limited GET once using bounded Retry-After", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        cloudflareResponse(null, {
          status: 429,
          success: false,
          errors: [{ message: "rate limited" }],
          headers: { "retry-after": "0.25" },
        }),
      )
      .mockResolvedValueOnce(cloudflareResponse([]));
    const adapter = createCloudflareFetchAdapter({
      fetch: fetchMock as typeof fetch,
      sleep,
      maxGetRetries: 2,
    });

    await expect(adapter.listAccounts({ credential: apiCredential })).resolves.toMatchObject({ items: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("bounds GET retry attempts for retryable server errors", async () => {
    const fetchMock = vi.fn(async () =>
      cloudflareResponse(null, {
        status: 503,
        success: false,
        errors: [{ message: "temporarily unavailable" }],
      }),
    );
    const adapter = createCloudflareFetchAdapter({
      fetch: fetchMock as typeof fetch,
      sleep: async () => undefined,
      maxGetRetries: 1,
    });

    await expect(adapter.listAccounts({ credential: apiCredential })).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a transient GET network failure but not an aborted request", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network reset"))
      .mockResolvedValueOnce(cloudflareResponse([]));
    const adapter = createCloudflareFetchAdapter({
      fetch: fetchMock as typeof fetch,
      sleep: async () => undefined,
    });
    await expect(adapter.listAccounts({ credential: apiCredential })).resolves.toMatchObject({ items: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const controller = new AbortController();
    controller.abort();
    const abortedFetch = vi.fn(async () => { throw new DOMException("aborted", "AbortError"); });
    const aborted = createCloudflareFetchAdapter({ fetch: abortedFetch as typeof fetch });
    await expect(aborted.listAccounts({ credential: apiCredential, signal: controller.signal })).rejects.toThrow("aborted");
    expect(abortedFetch).toHaveBeenCalledTimes(1);
  });

  it("never blindly replays a rate-limited tunnel create POST", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () =>
      cloudflareResponse(null, {
        status: 429,
        success: false,
        errors: [{ message: "rate limited" }],
      }),
    );
    const adapter = createCloudflareFetchAdapter({ fetch: fetchMock as typeof fetch, sleep });

    await expect(
      adapter.createTunnel({
        credential: apiCredential,
        accountId: "account-1",
        name: "toolspan-test",
        idempotencyKey: "idempotency-test",
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("never replays a tunnel create after an ambiguous network failure", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("connection closed after upload"); });
    const adapter = createCloudflareFetchAdapter({ fetch: fetchMock as typeof fetch });
    await expect(
      adapter.createTunnel({
        credential: apiCredential,
        accountId: "account-1",
        name: "toolspan-test",
        idempotencyKey: "idempotency-test",
      }),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not guess an idempotency header for a DNS create with an unknown outcome", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("connection closed after upload"); });
    const adapter = createCloudflareFetchAdapter({ fetch: fetchMock as typeof fetch });

    await expect(adapter.createDnsRecord({
      credential: apiCredential,
      zoneId: "zone-1",
      record: {
        type: "CNAME",
        name: "mcp.example.test",
        content: "tunnel-1.cfargotunnel.com",
        proxied: true,
        ttl: 1,
      },
      idempotencyKey: "idempotency-test",
    })).rejects.toBeInstanceOf(CloudflareOutcomeUnknownError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the expected tunnel method, path, and non-secret body", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      cloudflareResponse({ id: "tunnel-1", name: "toolspan-test", status: "inactive" }),
    );
    const adapter = createCloudflareFetchAdapter({ fetch: fetchMock as typeof fetch });
    await adapter.createTunnel({
      credential: apiCredential,
      accountId: "account/encoded",
      name: "toolspan-test",
      idempotencyKey: "idempotency-test",
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${CLOUDFLARE_API_ORIGIN}/client/v4/accounts/account%2Fencoded/cfd_tunnel`);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Headers).get("Idempotency-Key")).toBeNull();
    expect(JSON.parse(String(init?.body))).toEqual({ name: "toolspan-test", config_src: "cloudflare" });
    expect(String(init?.body)).not.toContain(apiCredential.token);
  });

  it("checks the DNS fingerprint before sending an ownership-sensitive update", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => cloudflareResponse({
      id: "dns-1",
      type: "CNAME",
      name: "mcp.example.test",
      content: "old.example.test",
      proxied: true,
      ttl: 1,
    }));
    const adapter = createCloudflareFetchAdapter({ fetch: fetchMock as typeof fetch });

    await expect(adapter.updateOwnedDnsRecord({
      credential: apiCredential,
      zoneId: "zone-1",
      recordId: "dns-1",
      record: {
        type: "CNAME",
        name: "mcp.example.test",
        content: "new.example.test",
        proxied: true,
        ttl: 1,
      },
      expectedFingerprint: "0".repeat(64),
    })).rejects.toBeInstanceOf(CloudflareConcurrencyError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it("serializes tunnel config preconditions and verifies the state after writing", async () => {
    const oldConfig = { ingress: [{ hostname: "mcp.example.test", service: "http_status:503" }] };
    const nextConfig = { ingress: [{ hostname: "mcp.example.test", service: "http://127.0.0.1:8787" }] };
    let releaseFirstRead!: () => void;
    let firstReadStarted!: () => void;
    const firstReadGate = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
    const firstReadSignal = new Promise<void>((resolve) => { firstReadStarted = resolve; });
    let readCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        readCount += 1;
        if (readCount === 1) {
          firstReadStarted();
          await firstReadGate;
          return cloudflareResponse({ config: oldConfig });
        }
        return cloudflareResponse({ config: nextConfig });
      }
      return cloudflareResponse({ config: nextConfig });
    });
    const adapter = createCloudflareFetchAdapter({ fetch: fetchMock as typeof fetch });
    const input = {
      credential: apiCredential,
      accountId: "account-1",
      tunnelId: "tunnel-1",
      config: nextConfig,
      expectedFingerprint: testFingerprint(oldConfig),
    };

    const first = adapter.updateTunnelConfig(input);
    await firstReadSignal;
    const second = adapter.updateTunnelConfig(input);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseFirstRead();

    await expect(first).resolves.toEqual(nextConfig);
    await expect(second).rejects.toBeInstanceOf(CloudflareConcurrencyError);
    expect(fetchMock.mock.calls.map((call) => call[1]?.method ?? "GET")).toEqual(["GET", "PUT", "GET", "GET"]);
  });

  it("verifies the remote DNS state after an ownership-sensitive update", async () => {
    const oldRecord = {
      id: "dns-1",
      zoneId: "zone-1",
      type: "CNAME" as const,
      name: "mcp.example.test",
      content: "old.example.test",
      proxied: true,
      ttl: 1,
    };
    const nextRecord = { ...oldRecord, content: "new.example.test" };
    let readCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        readCount += 1;
        return cloudflareResponse(readCount === 1 ? oldRecord : nextRecord);
      }
      return cloudflareResponse(oldRecord);
    });
    const adapter = createCloudflareFetchAdapter({ fetch: fetchMock as typeof fetch });

    await expect(adapter.updateOwnedDnsRecord({
      credential: apiCredential,
      zoneId: oldRecord.zoneId,
      recordId: oldRecord.id,
      record: {
        type: nextRecord.type,
        name: nextRecord.name,
        content: nextRecord.content,
        proxied: nextRecord.proxied,
        ttl: nextRecord.ttl,
      },
      expectedFingerprint: testFingerprint({
        type: oldRecord.type,
        name: oldRecord.name,
        content: oldRecord.content,
        proxied: oldRecord.proxied,
        ttl: oldRecord.ttl,
      }),
    })).resolves.toMatchObject(nextRecord);
    expect(fetchMock.mock.calls.map((call) => call[1]?.method ?? "GET")).toEqual(["GET", "PUT", "GET"]);
  });

  it("checks and verifies an ownership-sensitive DNS delete", async () => {
    const record = {
      id: "dns-1",
      zoneId: "zone-1",
      type: "CNAME" as const,
      name: "mcp.example.test",
      content: "tunnel-1.cfargotunnel.com",
      proxied: true,
      ttl: 1,
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return fetchMock.mock.calls.length === 1
          ? cloudflareResponse(record)
          : cloudflareResponse(null, { status: 404, success: false, errors: [{ message: "not found" }] });
      }
      return cloudflareResponse(null);
    });
    const adapter = createCloudflareFetchAdapter({ fetch: fetchMock as typeof fetch });

    await expect(adapter.deleteOwnedDnsRecord!({
      credential: apiCredential,
      zoneId: record.zoneId,
      recordId: record.id,
      expectedFingerprint: testFingerprint({
        type: record.type,
        name: record.name,
        content: record.content,
        proxied: record.proxied,
        ttl: record.ttl,
      }),
    })).resolves.toEqual({ deleted: true });
    expect(fetchMock.mock.calls.map((call) => call[1]?.method ?? "GET")).toEqual(["GET", "DELETE", "GET"]);
  });

  it("checks and verifies an ownership-sensitive DNS restore", async () => {
    const current = {
      id: "dns-1",
      zoneId: "zone-1",
      type: "CNAME" as const,
      name: "mcp.example.test",
      content: "new.example.test",
      proxied: true,
      ttl: 1,
    };
    const restored = { ...current, content: "old.example.test" };
    let readCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        readCount += 1;
        return cloudflareResponse(readCount === 1 ? current : restored);
      }
      return cloudflareResponse(current);
    });
    const adapter = createCloudflareFetchAdapter({ fetch: fetchMock as typeof fetch });

    await expect(adapter.restoreOwnedDnsRecord!({
      credential: apiCredential,
      zoneId: current.zoneId,
      record: restored,
      expectedFingerprint: testFingerprint({
        type: current.type,
        name: current.name,
        content: current.content,
        proxied: current.proxied,
        ttl: current.ttl,
      }),
    })).resolves.toMatchObject(restored);
    expect(fetchMock.mock.calls.map((call) => call[1]?.method ?? "GET")).toEqual(["GET", "PUT", "GET"]);
  });

  it("treats an incomplete successful tunnel create response as OUTCOME_UNKNOWN", async () => {
    const adapter = createCloudflareFetchAdapter({
      fetch: vi.fn(async () => cloudflareResponse({})) as typeof fetch,
    });

    await expect(adapter.createTunnel({
      credential: apiCredential,
      accountId: "account-1",
      name: "toolspan-test",
      idempotencyKey: "idempotency-test",
    })).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  });

  it("keeps a returned tunnel runtime credential out of adapter logs", async () => {
    const runtimeCredential = "runtime-token-must-not-log";
    const events: CloudflareLogEvent[] = [];
    const adapter = createCloudflareFetchAdapter({
      fetch: vi.fn(async () => cloudflareResponse(runtimeCredential)) as typeof fetch,
      logger: (event) => events.push(event),
    });
    await expect(
      adapter.getTunnelRuntimeCredential({
        credential: apiCredential,
        accountId: "account-1",
        tunnelId: "tunnel-1",
      }),
    ).resolves.toEqual({ token: runtimeCredential });
    expect(JSON.stringify(events)).not.toContain(runtimeCredential);
  });

  it("rejects an oversized Cloudflare response before parsing it", async () => {
    const adapter = createCloudflareFetchAdapter({
      fetch: vi.fn(async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": "1000" },
        }),
      ) as typeof fetch,
      maxResponseBytes: 100,
    });
    await expect(adapter.listAccounts({ credential: apiCredential })).rejects.toThrow("size limit");
  });

  it("rejects invalid JSON as a typed bounded API error", async () => {
    const adapter = createCloudflareFetchAdapter({
      fetch: vi.fn(async () => new Response("not-json", { status: 502 })) as typeof fetch,
      maxGetRetries: 0,
    });
    await expect(adapter.listAccounts({ credential: apiCredential })).rejects.toBeInstanceOf(CloudflareApiError);
  });
});

describe("cloudflared safety adapters", () => {
  it("returns a truthful manual/UAC checkpoint without retaining runtime credential", async () => {
    const adapter = createManualCloudflaredAdapter();
    await expect(adapter.inspect()).resolves.toEqual({ installed: false, serviceInstalled: false });
    const input = {
      sessionId: "session-manual",
      tunnelId: "tunnel-1",
      hostname: "mcp.example.test",
      localUrl: "http://127.0.0.1:8787",
      runtimeCredential: "runtime-token",
    };
    const error = await adapter.install(input).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CloudflaredManualCheckpointError);
    expect(error).toMatchObject({ code: "MANUAL_OR_UAC_REQUIRED" });
    expect(input.runtimeCredential).toBe("");
    await expect(adapter.uninstallOwnedService({
      sessionId: "session-manual",
      serviceId: "service-1",
      expectedFingerprint: "fingerprint",
    })).resolves.toEqual({ removed: false });
    await expect(adapter.verify({ serviceId: "service-1" })).resolves.toMatchObject({ healthy: false });
  });

  it("rejects a renamed executable before any local process launch", () => {
    expect(() =>
      createLocalCloudflaredAdapter({
        executablePath: path.join("C:\\", "tools", "not-cloudflared.exe"),
        serviceController: {
          async inspect() { return { serviceInstalled: false }; },
          async install() { throw new Error("must not be called"); },
          async uninstallOwnedService() { return { removed: false }; },
          async verify() { return { healthy: false, checkedAt: new Date(0).toISOString() }; },
        },
      }),
    ).toThrow("must be named cloudflared");
  });
});
