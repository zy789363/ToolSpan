import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CLOUDFLARE_API_ORIGIN,
  CloudflareApiError,
  createCloudflareFetchAdapter,
  type CloudflareLogEvent,
} from "../src/setup/cloudflare-fetch-adapter.js";
import {
  CloudflaredManualCheckpointError,
  createManualCloudflaredAdapter,
} from "../src/setup/cloudflared-adapter.js";
import { createLocalCloudflaredAdapter } from "../src/setup/local-cloudflared-adapter.js";

const apiCredential = { kind: "api_token" as const, token: "fake-api-token-value" };

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

  it("uses X-Auth headers for a matching Global API Key account", async () => {
    const credential = {
      kind: "global_api_key" as const,
      email: "owner@example.test",
      key: "fake-global-key",
      acknowledgement: "I UNDERSTAND GLOBAL API KEY ACCESS" as const,
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      cloudflareResponse({ email: "OWNER@example.test" }),
    );
    const adapter = createCloudflareFetchAdapter({ fetch: fetchMock as typeof fetch });

    await expect(adapter.verifyCredential({ credential })).resolves.toEqual({ valid: true });
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Headers;
    expect(headers.get("X-Auth-Email")).toBe(credential.email);
    expect(headers.get("X-Auth-Key")).toBe(credential.key);
    expect(headers.get("Authorization")).toBeNull();
  });

  it("rejects a Global API Key email mismatch truthfully", async () => {
    const adapter = createCloudflareFetchAdapter({
      fetch: vi.fn(async () => cloudflareResponse({ email: "different@example.test" })) as typeof fetch,
    });
    await expect(
      adapter.verifyCredential({
        credential: {
          kind: "global_api_key",
          email: "owner@example.test",
          key: "fake-global-key",
          acknowledgement: "I UNDERSTAND GLOBAL API KEY ACCESS",
        },
      }),
    ).rejects.toMatchObject({ code: "GLOBAL_KEY_EMAIL_MISMATCH" });
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
    ).rejects.toThrow("connection closed after upload");
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
    expect(JSON.parse(String(init?.body))).toEqual({ name: "toolspan-test", config_src: "cloudflare" });
    expect(String(init?.body)).not.toContain(apiCredential.token);
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
