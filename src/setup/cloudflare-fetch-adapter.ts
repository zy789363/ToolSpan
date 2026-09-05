import { createHash } from "node:crypto";

import {
  type CloudflareAccount,
  type CloudflareAdapter,
  type CloudflareCredential,
  type CloudflareDnsRecord,
  type CloudflarePage,
  type CloudflareTunnel,
  type CloudflareTunnelConfig,
  type CloudflareZone,
} from "./cloudflare-adapter.js";
import { credentialSecrets, redactText } from "./redaction.js";
import { SetupError } from "./types.js";

export const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com" as const;
const API_PREFIX = "/client/v4";

export interface CloudflareLogEvent {
  method: string;
  path: string;
  attempt: number;
  status?: number;
  outcome: "request" | "success" | "retry" | "error";
}

export interface CloudflareFetchAdapterOptions {
  fetch?: typeof globalThis.fetch;
  logger?: (event: CloudflareLogEvent) => void;
  maxGetRetries?: number;
  maxResponseBytes?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class CloudflareApiError extends Error {
  readonly status: number;
  readonly errors: readonly { code?: number; message: string }[];

  constructor(status: number, errors: readonly { code?: number; message: string }[]) {
    super(errors.map((error) => error.message).join("; ") || `Cloudflare API returned HTTP ${status}`);
    this.name = "CloudflareApiError";
    this.status = status;
    this.errors = errors;
  }
}

export class CloudflareConcurrencyError extends Error {
  readonly code = "FINGERPRINT_MISMATCH" as const;

  constructor(resource: string) {
    super(`${resource} changed since its expected fingerprint was captured`);
    this.name = "CloudflareConcurrencyError";
  }
}

export class CloudflareOutcomeUnknownError extends SetupError {
  readonly operation: string;

  constructor(operation: string, options?: ErrorOptions) {
    super({
      code: "OUTCOME_UNKNOWN",
      message: `Cloudflare ${operation} outcome is unknown; reconcile with a read-only lookup before retrying`,
    }, options);
    this.name = "CloudflareOutcomeUnknownError";
    this.operation = operation;
  }
}

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  errors?: { code?: number; message?: string }[];
  result_info?: { page?: number; total_pages?: number };
}

export function createCloudflareFetchAdapter(
  options: CloudflareFetchAdapterOptions = {},
): CloudflareAdapter {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const logger = options.logger ?? (() => undefined);
  const maxGetRetries = options.maxGetRetries ?? 2;
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const mutationTails = new Map<string, Promise<void>>();

  // Cloudflare does not expose a conditional-write primitive for these resources.
  // This serializes calls through this adapter instance; the GET is a precondition
  // check, not an atomic CAS. Every successful write is verified with a fresh GET.
  const withMutationLock = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const predecessor = mutationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    mutationTails.set(key, current);
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (mutationTails.get(key) === current) mutationTails.delete(key);
    }
  };

  const readAfterMutation = async <T>(operation: string, read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      throw new CloudflareOutcomeUnknownError(`${operation} write verification`, { cause: error });
    }
  };

    const request = async <T>(input: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    credential: CloudflareCredential;
    body?: unknown;
    signal?: AbortSignal;
    }): Promise<CloudflareEnvelope<T>> => {
      const method = input.method ?? "GET";
      const secrets = credentialSecrets(input.credential);
      const attempts = method === "GET" ? maxGetRetries + 1 : 1;
      const responseReadFailure = (operation: string, cause: unknown): never => {
        const safeError = new Error(
          redactText(cause instanceof Error ? cause.message : `Cloudflare ${operation} failed`, secrets),
          { cause },
        );
        if (method !== "GET") {
          throw new CloudflareOutcomeUnknownError(`${method} ${input.path} ${operation}`, { cause: safeError });
        }
        throw safeError;
      };
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
      logger({ method, path: input.path, attempt, outcome: "request" });
      let response: Response;
      try {
        response = await fetchImplementation(`${CLOUDFLARE_API_ORIGIN}${API_PREFIX}${input.path}`, {
          method,
          headers: requestHeaders(input.credential, input.body !== undefined),
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
          redirect: "error",
          signal: input.signal,
        });
      } catch (error) {
        if (method === "GET" && attempt < attempts && !input.signal?.aborted) {
          logger({ method, path: input.path, attempt, outcome: "retry" });
          await sleep(100 * attempt);
          continue;
        }
        logger({ method, path: input.path, attempt, outcome: "error" });
        const safeError = new Error(redactText(error instanceof Error ? error.message : "Cloudflare request failed", secrets), {
          cause: error,
        });
        if (method !== "GET") {
          throw new CloudflareOutcomeUnknownError(`${method} ${input.path}`, { cause: safeError });
        }
        throw safeError;
      }
      let contentLengthHeader: string | null;
      try {
        contentLengthHeader = response.headers.get("content-length");
      } catch (error) {
        responseReadFailure("content-length read", error);
      }
      const contentLength = Number(contentLengthHeader ?? 0);
      if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
        const error = new CloudflareApiError(response.status, [{ message: "Cloudflare response exceeded the size limit" }]);
        if (method !== "GET") throw new CloudflareOutcomeUnknownError(`${method} ${input.path}`, { cause: error });
        throw error;
      }
      let bodyText: string;
      try {
        bodyText = await response.text();
      } catch (error) {
        responseReadFailure("body read", error);
      }
      let bodyBytes: number;
      try {
        bodyBytes = Buffer.byteLength(bodyText, "utf8");
      } catch (error) {
        responseReadFailure("body size read", error);
      }
      if (bodyBytes > maxResponseBytes) {
        const error = new CloudflareApiError(response.status, [{ message: "Cloudflare response exceeded the size limit" }]);
        if (method !== "GET") throw new CloudflareOutcomeUnknownError(`${method} ${input.path}`, { cause: error });
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText) as unknown;
      } catch (error) {
        const apiError = new CloudflareApiError(response.status, [{ message: "Cloudflare returned an invalid JSON envelope" }]);
        if (method !== "GET") throw new CloudflareOutcomeUnknownError(`${method} ${input.path}`, { cause: apiError });
        throw apiError;
      }
      if (
        parsed === null
        || typeof parsed !== "object"
        || Array.isArray(parsed)
        || typeof (parsed as { success?: unknown }).success !== "boolean"
        || ((parsed as { success: boolean }).success && !Object.hasOwn(parsed, "result"))
      ) {
        const apiError = new CloudflareApiError(response.status, [{ message: "Cloudflare returned an invalid JSON envelope" }]);
        if (method !== "GET") throw new CloudflareOutcomeUnknownError(`${method} ${input.path}`, { cause: apiError });
        throw apiError;
      }
      const envelope = parsed as CloudflareEnvelope<T>;
      if (response.ok && envelope.success === true) {
        logger({ method, path: input.path, attempt, status: response.status, outcome: "success" });
        return envelope;
      }
      const errors = (envelope.errors ?? []).map((error) => ({
        ...(error.code === undefined ? {} : { code: error.code }),
        message: redactText(error.message ?? `Cloudflare API returned HTTP ${response.status}`, secrets),
      }));
      if (method !== "GET" && response.status >= 500) {
        logger({ method, path: input.path, attempt, status: response.status, outcome: "error" });
        throw new CloudflareOutcomeUnknownError(`${method} ${input.path} returned HTTP ${response.status}`);
      }
      if (method === "GET" && attempt < attempts && isRetryableStatus(response.status)) {
        logger({ method, path: input.path, attempt, status: response.status, outcome: "retry" });
        await sleep(retryDelay(response.headers.get("retry-after"), attempt));
        continue;
      }
      logger({ method, path: input.path, attempt, status: response.status, outcome: "error" });
      throw new CloudflareApiError(response.status, errors);
    }
    throw new Error("Cloudflare retry loop exhausted");
  };

  const readDnsRecord = async (input: {
    credential: CloudflareCredential;
    zoneId: string;
    recordId: string;
    signal?: AbortSignal;
  }): Promise<CloudflareDnsRecord | undefined> => {
    try {
      const envelope = await request<{
        id: string;
        type: string;
        name: string;
        content: string;
        proxied?: boolean;
        ttl?: number;
      }>({
        path: `/zones/${encodeURIComponent(input.zoneId)}/dns_records/${encodeURIComponent(input.recordId)}`,
        credential: input.credential,
        signal: input.signal,
      });
      return mapDns(input.zoneId, envelope.result);
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return undefined;
      throw error;
    }
  };

  const readTunnel = async (input: {
    credential: CloudflareCredential;
    accountId: string;
    tunnelId: string;
    signal?: AbortSignal;
  }): Promise<CloudflareTunnel | undefined> => {
    try {
      const envelope = await request<{
        id: string;
        name: string;
        status?: string;
        connections?: unknown[];
      }>({
        path: `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel/${encodeURIComponent(input.tunnelId)}`,
        credential: input.credential,
        signal: input.signal,
      });
      return {
        id: envelope.result.id,
        accountId: input.accountId,
        name: envelope.result.name,
        status: envelope.result.status ?? ((envelope.result.connections?.length ?? 0) > 0 ? "healthy" : "inactive"),
      };
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return undefined;
      throw error;
    }
  };

  const readTunnelConfig = async (input: {
    credential: CloudflareCredential;
    accountId: string;
    tunnelId: string;
    signal?: AbortSignal;
  }): Promise<CloudflareTunnelConfig | undefined> => {
    try {
      const envelope = await request<{ config?: CloudflareTunnelConfig }>({
        path: `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel/${encodeURIComponent(input.tunnelId)}/configurations`,
        credential: input.credential,
        signal: input.signal,
      });
      return envelope.result.config;
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return undefined;
      throw error;
    }
  };

  return {
    async verifyCredential({ credential, signal }) {
      await request<unknown>({ path: "/user/tokens/verify", credential, signal });
      return { valid: true };
    },

    async listAccounts(input) {
      const envelope = await request<Array<{ id: string; name: string }>>({
        path: withQuery("/accounts", { page: input.page, per_page: input.perPage }),
        credential: input.credential,
        signal: input.signal,
      });
      return page(envelope, envelope.result.map((account) => ({ id: account.id, name: account.name })));
    },

    async listZones(input) {
      const envelope = await request<Array<{
        id: string;
        name: string;
        status: string;
        account: { id: string };
        name_servers?: string[];
      }>>({
        path: withQuery("/zones", {
          "account.id": input.accountId,
          name: input.name,
          page: input.page,
          per_page: input.perPage,
        }),
        credential: input.credential,
        signal: input.signal,
      });
      return page(envelope, envelope.result.map((zone) => ({
        id: zone.id,
        accountId: zone.account.id,
        name: zone.name,
        status: zone.status,
        nameservers: zone.name_servers ?? [],
      })));
    },

    async listTunnels(input) {
      const envelope = await request<Array<{
        id: string;
        name: string;
        status?: string;
        connections?: unknown[];
      }>>({
        path: withQuery(`/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel`, {
          name: input.name,
          is_deleted: "false",
          page: input.page,
          per_page: input.perPage,
        }),
        credential: input.credential,
        signal: input.signal,
      });
      return page(envelope, envelope.result.map((tunnel) => ({
        id: tunnel.id,
        accountId: input.accountId,
        name: tunnel.name,
        status: tunnel.status ?? ((tunnel.connections?.length ?? 0) > 0 ? "healthy" : "inactive"),
      })));
    },

    async createTunnel(input) {
      const envelope = await request<{ id: string; name: string; status?: string }>({
        method: "POST",
        path: `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel`,
        credential: input.credential,
        body: { name: input.name, config_src: "cloudflare" },
        signal: input.signal,
      });
      if (
        envelope.result === null
        || typeof envelope.result !== "object"
        || typeof envelope.result.id !== "string"
        || typeof envelope.result.name !== "string"
      ) {
        throw new CloudflareOutcomeUnknownError("tunnel create response");
      }
      return {
        id: envelope.result.id,
        accountId: input.accountId,
        name: envelope.result.name,
        status: envelope.result.status ?? "inactive",
        ownedByToolSpan: true,
        ownershipKey: input.idempotencyKey,
      };
    },

    async readTunnelConfig(input) {
      return readTunnelConfig(input);
    },

    async updateTunnelConfig(input) {
      return withMutationLock(`tunnel-config:${input.accountId}:${input.tunnelId}`, async () => {
        if (input.expectedFingerprint !== undefined) {
          const current = await readTunnelConfig(input);
          if (current === undefined || fingerprint(current) !== input.expectedFingerprint) {
            throw new CloudflareConcurrencyError("Tunnel configuration");
          }
        }
        await request<{ config?: CloudflareTunnelConfig }>({
          method: "PUT",
          path: `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel/${encodeURIComponent(input.tunnelId)}/configurations`,
          credential: input.credential,
          body: { config: input.config },
          signal: input.signal,
        });
        const verified = await readAfterMutation("tunnel configuration", () => readTunnelConfig(input));
        if (verified === undefined || fingerprint(verified) !== fingerprint(input.config)) {
          throw new CloudflareConcurrencyError("Tunnel configuration after update");
        }
        return verified;
      });
    },

    async getTunnelRuntimeCredential(input) {
      const envelope = await request<string>({
        path: `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel/${encodeURIComponent(input.tunnelId)}/token`,
        credential: input.credential,
        signal: input.signal,
      });
      return { token: envelope.result };
    },

    async listDnsRecords(input) {
      const envelope = await request<Array<{
        id: string;
        type: string;
        name: string;
        content: string;
        proxied?: boolean;
        ttl?: number;
      }>>({
        path: withQuery(`/zones/${encodeURIComponent(input.zoneId)}/dns_records`, {
          type: "CNAME",
          name: input.name,
          page: input.page,
          per_page: input.perPage,
        }),
        credential: input.credential,
        signal: input.signal,
      });
      return page(envelope, envelope.result.map((record) => mapDns(input.zoneId, record)));
    },

    async createDnsRecord(input) {
      const envelope = await request<{ id: string; type: string; name: string; content: string; proxied?: boolean; ttl?: number }>({
        method: "POST",
        path: `/zones/${encodeURIComponent(input.zoneId)}/dns_records`,
        credential: input.credential,
        body: stripOwnership(input.record),
        signal: input.signal,
      });
      try {
        if (
          envelope.result === null
          || typeof envelope.result !== "object"
          || typeof envelope.result.id !== "string"
          || typeof envelope.result.type !== "string"
          || typeof envelope.result.name !== "string"
          || typeof envelope.result.content !== "string"
        ) {
          throw new Error("Cloudflare returned an incomplete DNS record");
        }
        return {
          ...mapDns(input.zoneId, envelope.result),
          ownedByToolSpan: true,
          ownershipKey: input.idempotencyKey,
        };
      } catch (error) {
        throw new CloudflareOutcomeUnknownError("DNS record create response", { cause: error });
      }
    },

    async updateOwnedDnsRecord(input) {
      return withMutationLock(`dns:${input.zoneId}:${input.recordId}`, async () => {
        const current = await readDnsRecord(input);
        if (current === undefined || dnsFingerprint(current) !== input.expectedFingerprint) {
          throw new CloudflareConcurrencyError("DNS record");
        }
        await request<{ id: string; type: string; name: string; content: string; proxied?: boolean; ttl?: number }>({
          method: "PUT",
          path: `/zones/${encodeURIComponent(input.zoneId)}/dns_records/${encodeURIComponent(input.recordId)}`,
          credential: input.credential,
          body: stripOwnership(input.record),
          signal: input.signal,
        });
        const verified = await readAfterMutation("DNS record update", () => readDnsRecord(input));
        if (verified === undefined || dnsFingerprint(verified) !== dnsFingerprint(input.record)) {
          throw new CloudflareConcurrencyError("DNS record after update");
        }
        return { ...verified, ownedByToolSpan: true };
      });
    },

    async verifyTunnelHealth(input) {
      const envelope = await request<{ status?: string; connections?: unknown[] }>({
        path: `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel/${encodeURIComponent(input.tunnelId)}`,
        credential: input.credential,
        signal: input.signal,
      });
      const healthy = envelope.result.status === "healthy" || (envelope.result.connections?.length ?? 0) > 0;
      return { healthy, checkedAt: new Date().toISOString() };
    },

    async deleteOwnedTunnel(input) {
      return withMutationLock(`tunnel:${input.accountId}:${input.tunnelId}`, async () => {
        const current = await readTunnel(input);
        if (current === undefined || tunnelFingerprint(current) !== input.expectedFingerprint) {
          throw new CloudflareConcurrencyError("Cloudflare tunnel");
        }
        await request<unknown>({
          method: "DELETE",
          path: `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel/${encodeURIComponent(input.tunnelId)}`,
          credential: input.credential,
          signal: input.signal,
        });
        const verified = await readAfterMutation("tunnel delete", () => readTunnel(input));
        if (verified !== undefined) throw new CloudflareConcurrencyError("Cloudflare tunnel after delete");
        return { deleted: true };
      });
    },

    async deleteOwnedDnsRecord(input) {
      return withMutationLock(`dns:${input.zoneId}:${input.recordId}`, async () => {
        const current = await readDnsRecord(input);
        if (current === undefined || dnsFingerprint(current) !== input.expectedFingerprint) {
          throw new CloudflareConcurrencyError("DNS record");
        }
        await request<unknown>({
          method: "DELETE",
          path: `/zones/${encodeURIComponent(input.zoneId)}/dns_records/${encodeURIComponent(input.recordId)}`,
          credential: input.credential,
          signal: input.signal,
        });
        const verified = await readAfterMutation("DNS record delete", () => readDnsRecord(input));
        if (verified !== undefined) throw new CloudflareConcurrencyError("DNS record after delete");
        return { deleted: true };
      });
    },

    async restoreOwnedDnsRecord(input) {
      return withMutationLock(`dns:${input.zoneId}:${input.record.id}`, async () => {
        const current = await readDnsRecord({
          ...input,
          recordId: input.record.id,
        });
        if (current === undefined || dnsFingerprint(current) !== input.expectedFingerprint) {
          throw new CloudflareConcurrencyError("DNS record");
        }
        await request<{ id: string; type: string; name: string; content: string; proxied?: boolean; ttl?: number }>({
          method: "PUT",
          path: `/zones/${encodeURIComponent(input.zoneId)}/dns_records/${encodeURIComponent(input.record.id)}`,
          credential: input.credential,
          body: stripOwnership(input.record),
          signal: input.signal,
        });
        const verified = await readAfterMutation("DNS record restore", () => readDnsRecord({
          ...input,
          recordId: input.record.id,
        }));
        if (verified === undefined || dnsFingerprint(verified) !== dnsFingerprint(input.record)) {
          throw new CloudflareConcurrencyError("DNS record after restore");
        }
        return { ...verified, ownedByToolSpan: true };
      });
    },
  };
}

function requestHeaders(credential: CloudflareCredential, json: boolean): Headers {
  const headers = new Headers({ Accept: "application/json" });
  if (json) headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${credential.token}`);
  return headers;
}

function withQuery(path: string, query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded.length === 0 ? path : `${path}?${encoded}`;
}

function page<T>(envelope: CloudflareEnvelope<unknown>, items: T[]): CloudflarePage<T> {
  return {
    items,
    page: envelope.result_info?.page ?? 1,
    totalPages: envelope.result_info?.total_pages ?? 1,
  };
}

function mapDns(
  zoneId: string,
  record: { id: string; type: string; name: string; content: string; proxied?: boolean; ttl?: number },
): CloudflareDnsRecord {
  if (record.type !== "CNAME") throw new Error(`Unexpected DNS record type: ${record.type}`);
  return {
    id: record.id,
    zoneId,
    type: "CNAME",
    name: record.name,
    content: record.content,
    proxied: record.proxied ?? false,
    ttl: record.ttl ?? 1,
  };
}

function stripOwnership(
  record: Omit<CloudflareDnsRecord, "id" | "zoneId"> | CloudflareDnsRecord,
): { type: "CNAME"; name: string; content: string; proxied: boolean; ttl: number } {
  return {
    type: record.type,
    name: record.name,
    content: record.content,
    proxied: record.proxied,
    ttl: record.ttl,
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function retryDelay(retryAfter: string | null, attempt: number): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5_000);
  return Math.min(100 * 2 ** (attempt - 1), 5_000);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function tunnelFingerprint(tunnel: CloudflareTunnel): string {
  return fingerprint({ id: tunnel.id, accountId: tunnel.accountId, name: tunnel.name });
}

function dnsFingerprint(record: Pick<CloudflareDnsRecord, "type" | "name" | "content" | "proxied" | "ttl">): string {
  return fingerprint({
    type: record.type,
    name: record.name,
    content: record.content,
    proxied: record.proxied,
    ttl: record.ttl,
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
