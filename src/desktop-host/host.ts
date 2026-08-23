import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { SERVICE_INFO } from "../service-info.js";

export const DESKTOP_PROTOCOL_METHODS = [
  "system.hello",
  "runtime.getSnapshot",
  "runtime.start",
  "runtime.stop",
  "runtime.restart",
  "runtime.validateConfig",
  "runtime.getConfigSummary",
  "runtime.listJobs",
  "runtime.cancelJob",
  "runtime.listArtifacts",
  "runtime.getLogChunk",
  "runtime.subscribeEvents",
  "connection.testLocal",
  "connection.testPublic",
  "setup.getSnapshot",
  "setup.preflight",
  "setup.plan",
  "setup.apply",
  "setup.rollback",
  "setup.reconcile",
  "setup.discardCredential",
] as const;

export type DesktopProtocolMethod = typeof DESKTOP_PROTOCOL_METHODS[number];
export type DesktopServiceMethod = Exclude<DesktopProtocolMethod, "system.hello">;
export type DesktopHostEvent = {
  event: "runtime.snapshot" | "runtime.log" | "runtime.attention";
  data: unknown;
};

const SERVICE_METHODS = new Set<string>(DESKTOP_PROTOCOL_METHODS.slice(1));
const JOB_STATUSES = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);
const SETUP_DOMAIN_CHOICES = new Set([
  "existing",
  "other_registrar",
  "namesilo_no_referral",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128;
}

function isSetupId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= 128
    && /^[A-Za-z0-9_-]+$/u.test(value);
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function isDomainName(value: unknown): value is string {
  if (
    !isBoundedString(value, 253)
    || value.endsWith(".")
    || value !== value.toLowerCase()
  ) return false;
  const labels = value.split(".");
  return labels.length >= 2 && labels.every((label) =>
    label.length >= 1
      && label.length <= 63
      && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label)
  );
}

function parseSafeUrl(value: unknown): URL | undefined {
  if (!isBoundedString(value, 2_048)) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function hasPersonalPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || /(?:^|[\\/])Users[\\/]/iu.test(value);
}

function isSetupCredential(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind !== "api_token") return false;
  return hasOnlyKeys(value, ["kind", "token"])
    && isBoundedString(value.token, 65_536)
    && value.token.trim() === value.token;
}

function isSetupManifest(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "schemaVersion",
    "toolSpanVersion",
    "instanceName",
    "localUrl",
    "desiredHostname",
    "publicMcpUrl",
    "oauthDiscoveryUrl",
    "expectedToolCount",
    "tunnelName",
    "domainChoice",
    "officialDocs",
    "generatedAt",
  ])) return false;
  const localUrl = parseSafeUrl(value.localUrl);
  const publicMcpUrl = parseSafeUrl(value.publicMcpUrl);
  const oauthDiscoveryUrl = parseSafeUrl(value.oauthDiscoveryUrl);
  if (!isDomainName(value.desiredHostname)) return false;
  return value.schemaVersion === "1.0"
    && value.toolSpanVersion === SERVICE_INFO.version
    && isBoundedString(value.instanceName, 80)
    && !hasPersonalPath(value.instanceName)
    && localUrl?.protocol === "http:"
    && (localUrl.hostname === "127.0.0.1" || localUrl.hostname === "localhost")
    && localUrl.pathname === "/"
    && localUrl.search === ""
    && publicMcpUrl?.protocol === "https:"
    && publicMcpUrl.hostname === value.desiredHostname
    && publicMcpUrl.port === ""
    && publicMcpUrl.pathname === "/mcp"
    && publicMcpUrl.search === ""
    && oauthDiscoveryUrl?.protocol === "https:"
    && oauthDiscoveryUrl.hostname === value.desiredHostname
    && oauthDiscoveryUrl.port === ""
    && oauthDiscoveryUrl.pathname === "/.well-known/oauth-authorization-server"
    && oauthDiscoveryUrl.search === ""
    && value.expectedToolCount === 27
    && isBoundedString(value.tunnelName, 100)
    && !hasPersonalPath(value.tunnelName)
    && typeof value.domainChoice === "string"
    && SETUP_DOMAIN_CHOICES.has(value.domainChoice)
    && Array.isArray(value.officialDocs)
    && value.officialDocs.length >= 1
    && new Set(value.officialDocs).size === value.officialDocs.length
    && value.officialDocs.every((item) => {
      const url = parseSafeUrl(item);
      return url?.protocol === "https:"
        && url.port === ""
        && (url.hostname === "developers.cloudflare.com" || url.hostname === "developers.openai.com");
    })
    && isBoundedString(value.generatedAt, 64)
    && !Number.isNaN(Date.parse(value.generatedAt));
}

function isEmptyParams(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function validServiceParams(method: DesktopServiceMethod, value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (method) {
    case "runtime.getSnapshot":
    case "runtime.start":
    case "runtime.stop":
    case "runtime.restart":
    case "runtime.validateConfig":
    case "runtime.getConfigSummary":
    case "connection.testLocal":
    case "connection.testPublic":
      return isEmptyParams(value);
    case "setup.getSnapshot":
      return hasOnlyKeys(value, ["sessionId"])
        && (value.sessionId === undefined || isSetupId(value.sessionId));
    case "setup.preflight":
      return hasOnlyKeys(value, ["sessionId", "idempotencyKey", "zoneName", "manifest", "credential"])
        && isSetupId(value.sessionId)
        && isSetupId(value.idempotencyKey)
        && isDomainName(value.zoneName)
        && isSetupManifest(value.manifest)
        && (value.credential === undefined || isSetupCredential(value.credential));
    case "setup.plan":
      return hasOnlyKeys(value, ["sessionId"]) && isSetupId(value.sessionId);
    case "setup.apply":
      return hasOnlyKeys(value, ["sessionId", "confirmation", "credential"])
        && isSetupId(value.sessionId)
        && value.confirmation === "APPLY"
        && (value.credential === undefined || isSetupCredential(value.credential));
    case "setup.rollback":
      return hasOnlyKeys(value, ["sessionId", "confirmation", "credential"])
        && isSetupId(value.sessionId)
        && value.confirmation === "ROLLBACK"
        && (value.credential === undefined || isSetupCredential(value.credential));
    case "setup.reconcile":
      return hasOnlyKeys(value, ["sessionId", "credential"])
        && isSetupId(value.sessionId)
        && (value.credential === undefined || isSetupCredential(value.credential));
    case "setup.discardCredential":
      return hasOnlyKeys(value, ["sessionId"]) && isSetupId(value.sessionId);
    case "runtime.listJobs":
      return hasOnlyKeys(value, ["workspaceId", "status"])
        && (value.workspaceId === undefined || isBoundedId(value.workspaceId))
        && (value.status === undefined || (
          typeof value.status === "string" && JOB_STATUSES.has(value.status)
        ));
    case "runtime.cancelJob":
      return hasOnlyKeys(value, ["jobId"]) && isBoundedId(value.jobId);
    case "runtime.listArtifacts":
      return hasOnlyKeys(value, ["workspaceId"])
        && (value.workspaceId === undefined || isBoundedId(value.workspaceId));
    case "runtime.getLogChunk":
      return hasOnlyKeys(value, ["cursor", "limit"])
        && (value.cursor === undefined || (
          Number.isInteger(value.cursor) && (value.cursor as number) >= 0
        ))
        && (value.limit === undefined || (
          Number.isInteger(value.limit) && (value.limit as number) >= 1 && (value.limit as number) <= 65_536
        ));
    case "runtime.subscribeEvents":
      return hasOnlyKeys(value, ["enabled"]) && typeof value.enabled === "boolean";
  }
}

class RequestTimeoutError extends Error {}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RequestTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface DesktopHostService {
  invoke(method: DesktopServiceMethod, params: unknown): Promise<unknown>;
  subscribeEvents?(listener: (event: DesktopHostEvent) => void): () => void;
}

export interface DesktopHostOptions {
  input: Readable;
  output: Writable;
  errorOutput: Writable;
  service: DesktopHostService;
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
}

export async function runDesktopHost(options: DesktopHostOptions): Promise<void> {
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  const maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  let handshakeComplete = false;
  let eventsEnabled = false;
  const requestIds = new Set<string>();
  const unsubscribe = options.service.subscribeEvents?.((event) => {
    if (!eventsEnabled) return;
    try {
      const message = JSON.stringify(event);
      if (Buffer.byteLength(message, "utf8") <= maxMessageBytes) {
        options.output.write(`${message}\n`);
      }
    } catch {
      // A malformed service event must not damage the request/response channel.
    }
  });
  for await (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > maxMessageBytes) {
      options.output.write(`${JSON.stringify({
        id: null,
        ok: false,
        error: { code: "MESSAGE_TOO_LARGE", message: "Message exceeds the 1 MiB limit" },
      })}\n`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      options.output.write(`${JSON.stringify({
        id: null,
        ok: false,
        error: { code: "INVALID_MESSAGE", message: "Message must be valid protocol JSON" },
      })}\n`);
      continue;
    }
    if (
      !isRecord(parsed)
      || !hasOnlyKeys(parsed, ["id", "method", "params"])
      || !isBoundedId(parsed.id)
      || typeof parsed.method !== "string"
      || !isRecord(parsed.params)
    ) {
      options.output.write(`${JSON.stringify({
        id: isRecord(parsed) && isBoundedId(parsed.id) ? parsed.id : null,
        ok: false,
        error: { code: "INVALID_MESSAGE", message: "Message does not match the protocol" },
      })}\n`);
      continue;
    }
    const request = parsed as {
      id: string;
      method: string;
      params: Record<string, unknown> & { protocolVersion?: unknown };
    };
    if (requestIds.has(request.id)) {
      options.output.write(`${JSON.stringify({
        id: request.id,
        ok: false,
        error: {
          code: "DUPLICATE_REQUEST_ID",
          message: "Request id has already been used",
        },
      })}\n`);
      continue;
    }
    requestIds.add(request.id);
    if (request.method === "system.hello" && request.params.protocolVersion !== 1) {
      options.output.write(`${JSON.stringify({
        id: request.id,
        ok: false,
        error: {
          code: "PROTOCOL_VERSION_MISMATCH",
          message: "Desktop protocol version 1 is required",
        },
      })}\n`);
    } else if (
      request.method === "system.hello" &&
      "productVersion" in request.params &&
      request.params.productVersion !== SERVICE_INFO.version
    ) {
      options.output.write(`${JSON.stringify({
        id: request.id,
        ok: false,
        error: {
          code: "PRODUCT_VERSION_MISMATCH",
          message: `Desktop product version ${SERVICE_INFO.version} is required`,
        },
      })}\n`);
    } else if (request.method === "system.hello") {
      handshakeComplete = true;
      options.output.write(`${JSON.stringify({
        id: request.id,
        ok: true,
        result: {
          protocolVersion: 1,
          productVersion: SERVICE_INFO.version,
          capabilities: ["runtime", "connection", "jobs", "artifacts", "logs", "setup"],
        },
      })}\n`);
    } else if (!handshakeComplete) {
      options.output.write(`${JSON.stringify({
        id: request.id,
        ok: false,
        error: {
          code: "HANDSHAKE_REQUIRED",
          message: "system.hello must complete before other methods",
        },
      })}\n`);
    } else if (!SERVICE_METHODS.has(request.method)) {
      options.output.write(`${JSON.stringify({
        id: request.id,
        ok: false,
        error: { code: "UNKNOWN_METHOD", message: "Method is not available" },
      })}\n`);
    } else if (!validServiceParams(request.method as DesktopServiceMethod, request.params)) {
      options.output.write(`${JSON.stringify({
        id: request.id,
        ok: false,
        error: { code: "INVALID_PARAMS", message: "Method parameters are invalid" },
      })}\n`);
    } else {
      try {
        if (
          request.method === "runtime.subscribeEvents"
          && request.params.enabled === false
        ) {
          eventsEnabled = false;
        }
        const result = await withTimeout(
          options.service.invoke(request.method as DesktopServiceMethod, request.params),
          requestTimeoutMs,
        );
        options.output.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
        if (
          request.method === "runtime.subscribeEvents"
          && request.params.enabled === true
        ) {
          eventsEnabled = true;
        }
      } catch (error) {
        const timedOut = error instanceof RequestTimeoutError;
        options.output.write(`${JSON.stringify({
          id: request.id,
          ok: false,
          error: timedOut
            ? { code: "REQUEST_TIMEOUT", message: "Desktop host request timed out" }
            : { code: "SERVICE_ERROR", message: "Desktop host operation failed" },
        })}\n`);
      }
    }
  }
  unsubscribe?.();
}
