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
        throw new Error(redactText(error instanceof Error ? error.message : "Cloudflare request failed", secrets), {
          cause: error,
        });
      }
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
        throw new CloudflareApiError(response.status, [{ message: "Cloudflare response exceeded the size limit" }]);
      }
      const bodyText = await response.text();
      if (Buffer.byteLength(bodyText, "utf8") > maxResponseBytes) {
        throw new CloudflareApiError(response.status, [{ message: "Cloudflare response exceeded the size limit" }]);
      }
      let envelope: CloudflareEnvelope<T>;
      try {
        envelope = JSON.parse(bodyText) as CloudflareEnvelope<T>;
      } catch (error) {
        throw new CloudflareApiError(response.status, [{ message: "Cloudflare returned an invalid JSON envelope" }]);
      }
      if (response.ok && envelope.success === true) {
        logger({ method, path: input.path, attempt, status: response.status, outcome: "success" });
        return envelope;
      }
      const errors = (envelope.errors ?? []).map((error) => ({
        ...(error.code === undefined ? {} : { code: error.code }),
        message: redactText(error.message ?? `Cloudflare API returned HTTP ${response.status}`, secrets),
      }));
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
    },

    async updateTunnelConfig(input) {
      const envelope = await request<{ config?: CloudflareTunnelConfig }>({
        method: "PUT",
        path: `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel/${encodeURIComponent(input.tunnelId)}/configurations`,
        credential: input.credential,
        body: { config: input.config },
        signal: input.signal,
      });
      return envelope.result.config ?? input.config;
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
      return {
        ...mapDns(input.zoneId, envelope.result),
        ownedByToolSpan: true,
        ownershipKey: input.idempotencyKey,
      };
    },

    async updateOwnedDnsRecord(input) {
      const envelope = await request<{ id: string; type: string; name: string; content: string; proxied?: boolean; ttl?: number }>({
        method: "PUT",
        path: `/zones/${encodeURIComponent(input.zoneId)}/dns_records/${encodeURIComponent(input.recordId)}`,
        credential: input.credential,
        body: stripOwnership(input.record),
        signal: input.signal,
      });
      return { ...mapDns(input.zoneId, envelope.result), ownedByToolSpan: true };
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
      await request<unknown>({
        method: "DELETE",
        path: `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel/${encodeURIComponent(input.tunnelId)}`,
        credential: input.credential,
        signal: input.signal,
      });
      return { deleted: true };
    },

    async deleteOwnedDnsRecord(input) {
      await request<unknown>({
        method: "DELETE",
        path: `/zones/${encodeURIComponent(input.zoneId)}/dns_records/${encodeURIComponent(input.recordId)}`,
        credential: input.credential,
        signal: input.signal,
      });
      return { deleted: true };
    },

    async restoreOwnedDnsRecord(input) {
      const restored = await request<{ id: string; type: string; name: string; content: string; proxied?: boolean; ttl?: number }>({
        method: "PUT",
        path: `/zones/${encodeURIComponent(input.zoneId)}/dns_records/${encodeURIComponent(input.record.id)}`,
        credential: input.credential,
        body: stripOwnership(input.record),
        signal: input.signal,
      });
      return { ...mapDns(input.zoneId, restored.result), ownedByToolSpan: true };
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
