import { createHash } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { lookup as lookupDns } from "node:dns/promises";
import { once } from "node:events";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import http, { type Server } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import path from "node:path";

import type { ArtifactRecord } from "../artifacts/artifact-service.js";
import { loadConfig, type ToolSpanConfig } from "../config.js";
import type { JobRecord, JobStatus } from "../jobs/job-service.js";
import { createRuntime } from "../runtime.js";
import { SERVICE_INFO } from "../service-info.js";
import type {
  DesktopHostEvent,
  DesktopHostService,
  DesktopServiceMethod,
} from "./host.js";
import {
  createProductionDesktopSetupService,
  type DesktopSetupService,
} from "./setup-service.js";

const MCP_TOOL_COUNT = 27;
const MAX_PROBE_BODY_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_PUBLIC_REDIRECTS = 3;

type Runtime = Awaited<ReturnType<typeof createRuntime>>;

interface ActiveRuntime {
  config: ToolSpanConfig;
  runtime: Runtime;
  server: Server;
}

interface ProbeResponse {
  status: number;
  location?: string;
  body: string;
}

export interface DesktopProductionServiceOptions {
  configPath: string;
  logPath?: string;
  now?: () => number;
  lookupAddresses?: (hostname: string) => Promise<readonly LookupAddress[]>;
  probeLocal?: (url: URL) => Promise<ProbeResponse>;
  probePublic?: (url: URL, address: LookupAddress) => Promise<ProbeResponse>;
  setupService?: DesktopSetupService;
}

export interface DesktopProductionService extends DesktopHostService {
  close(): Promise<void>;
}

type RuntimeState = "stopped" | "starting" | "running" | "stopping" | "attention";

interface ConfigSummary {
  instanceName: string | null;
  host: ToolSpanConfig["host"];
  port: number;
  localBaseUrl: string;
  publicBaseUrl: string;
  allowedRoots: string[];
  stateDirectory: string;
  allowedOrigins: string[];
}

interface RuntimeSnapshot {
  state: RuntimeState;
  productVersion: string;
  instanceName: string | null;
  localEndpoint: string | null;
  publicBaseUrl: string | null;
  mcpTools: { available: number; total: number };
  uptimeSeconds: number | null;
  localReady: boolean;
  publicReady: boolean | null;
  recentJobs: JobRecord[];
  recentArtifacts: ArtifactRecord[];
  firstRunRequired: boolean;
  statePath: string;
  logPath: string;
  workspaces: Array<{ id: string; name: string; path: string; access: "read-write" }>;
  managedByDesktop: boolean;
  nodeVersion: string;
  nodePathConfigured: boolean;
  ownerPasswordConfigured: boolean;
  oauthDiscoveryUrl: string | null;
  lastUpdatedAt: string;
}

interface ConnectionTestResult {
  target: "local" | "public";
  ok: boolean;
  status: number | null;
  latencyMs: number;
  service: string | null;
  version: string | null;
  error: "CONNECTION_FAILED" | "INVALID_HEALTH_RESPONSE" | "PUBLIC_TARGET_NOT_ALLOWED" | null;
}

function loopbackBaseUrl(config: ToolSpanConfig): string {
  const hostname = config.host === "::1" ? "[::1]" : config.host;
  return `http://${hostname}:${String(config.port)}`;
}

function summarizeConfig(config: ToolSpanConfig): ConfigSummary {
  return {
    instanceName: config.instanceName ?? null,
    host: config.host,
    port: config.port,
    localBaseUrl: loopbackBaseUrl(config),
    publicBaseUrl: config.publicBaseUrl,
    allowedRoots: [...config.allowedRoots],
    stateDirectory: config.stateDirectory,
    allowedOrigins: [...config.allowedOrigins],
  };
}

function workspaceRoot(root: string): RuntimeSnapshot["workspaces"][number] {
  return {
    id: `root-${createHash("sha256").update(root).digest("hex")}`,
    name: path.basename(root) || "Workspace",
    path: root,
    access: "read-write",
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function boundedResponse(
  request: ReturnType<typeof http.request> | ReturnType<typeof https.request>,
): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    request.once("response", (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_PROBE_BODY_BYTES) {
          request.destroy(new Error("Response body exceeded the limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          location: Array.isArray(response.headers.location)
            ? response.headers.location[0]
            : response.headers.location,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      response.once("error", reject);
    });
    request.once("error", reject);
    request.setTimeout(PROBE_TIMEOUT_MS, () => request.destroy(new Error("Request timed out")));
    request.end();
  });
}

function defaultProbeLocal(url: URL): Promise<ProbeResponse> {
  const request = http.request(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  return boundedResponse(request);
}

function defaultProbePublic(url: URL, address: LookupAddress): Promise<ProbeResponse> {
  const request = https.request({
    protocol: "https:",
    hostname: address.address,
    family: address.family,
    port: url.port === "" ? 443 : Number(url.port),
    path: `${url.pathname}${url.search}`,
    method: "GET",
    servername: url.hostname,
    headers: {
      accept: "application/json",
      host: url.host,
    },
  });
  return boundedResponse(request);
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }
  const [first = 0, second = 0, third = 0] = octets;
  return first === 0
    || first === 10
    || first === 127
    || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 192 && second === 0)
    || (first === 192 && second === 0 && third === 2)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113);
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0] ?? address.toLowerCase();
  const family = isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family !== 6) return true;
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpv4(normalized.slice("::ffff:".length));
  }
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/u.test(normalized)
    || normalized.startsWith("ff")
    || normalized.startsWith("2001:db8:");
}

function parseHealth(response: ProbeResponse): { service: string; version: string } | undefined {
  if (response.status !== 200) return undefined;
  try {
    const body = JSON.parse(response.body) as unknown;
    if (
      typeof body === "object"
      && body !== null
      && (body as Record<string, unknown>).status === "ok"
      && (body as Record<string, unknown>).service === SERVICE_INFO.service
      && typeof (body as Record<string, unknown>).version === "string"
    ) {
      return {
        service: SERVICE_INFO.service,
        version: (body as Record<string, unknown>).version as string,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function sanitizeLogs(value: string): string {
  return value
    .split(/(?<=\n)/u)
    .map((line) => {
      if (/(?:authorization|password|token|secret|credential|api[\s_-]*key)/iu.test(line)) {
        return line.endsWith("\n") ? "[REDACTED SENSITIVE LOG LINE]\n" : "[REDACTED SENSITIVE LOG LINE]";
      }
      return line
        .replace(/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/gu, "[REDACTED]")
        .replace(/(https?:\/\/)[^/@\s]+:[^@\s]+@/giu, "$1[REDACTED]@");
    })
    .join("");
}

export function createDesktopProductionService(
  options: DesktopProductionServiceOptions,
): DesktopProductionService {
  const now = options.now ?? Date.now;
  const lookupAddresses = options.lookupAddresses
    ?? (async (hostname: string) => lookupDns(hostname, { all: true, verbatim: true }));
  const probeLocal = options.probeLocal ?? defaultProbeLocal;
  const probePublic = options.probePublic ?? defaultProbePublic;
  const listeners = new Set<(event: DesktopHostEvent) => void>();
  const safeLog: string[] = [];
  const logPath = options.logPath;
  let logWrite = Promise.resolve();
  let active: ActiveRuntime | undefined;
  let setupService = options.setupService;
  let state: RuntimeState = "stopped";
  let lastPublicReady: boolean | null = null;

  const appendLog = (message: string): void => {
    const line = `${new Date(now()).toISOString()} ${message}\n`;
    safeLog.push(line);
    if (safeLog.length > 500) safeLog.shift();
    if (logPath === undefined) return;
    logWrite = logWrite
      .then(async () => {
        await mkdir(path.dirname(logPath), { recursive: true });
        await appendFile(logPath, line, "utf8");
      })
      .catch(() => undefined);
  };

  const flushLogs = async (): Promise<void> => {
    await logWrite;
  };

  const emit = (event: DesktopHostEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const loadCurrentConfig = async (): Promise<ToolSpanConfig> => active?.config ?? loadConfig(options.configPath);

  const loadSetupService = async (): Promise<DesktopSetupService> => {
    if (setupService !== undefined) return setupService;
    const config = await loadCurrentConfig();
    setupService = createProductionDesktopSetupService(path.join(config.stateDirectory, "setup"));
    return setupService;
  };

  const snapshot = async (): Promise<RuntimeSnapshot> => {
    let config = active?.config;
    if (config === undefined) {
      try {
        config = await loadConfig(options.configPath);
      } catch {
        config = undefined;
      }
    }
    const [jobs, artifacts] = active === undefined
      ? [[], []]
      : await Promise.all([
        active.runtime.services.jobs.listJobs(),
        active.runtime.services.artifacts.listArtifacts(),
      ]);
    return {
      state,
      productVersion: SERVICE_INFO.version,
      instanceName: config?.instanceName ?? null,
      localEndpoint: config === undefined ? null : `${loopbackBaseUrl(config)}/mcp`,
      publicBaseUrl: config?.publicBaseUrl ?? null,
      mcpTools: { available: active === undefined ? 0 : MCP_TOOL_COUNT, total: MCP_TOOL_COUNT },
      uptimeSeconds: active === undefined
        ? null
        : Math.max(0, Math.floor((now() - active.runtime.services.startedAt) / 1000)),
      localReady: active !== undefined,
      publicReady: lastPublicReady,
      recentJobs: jobs.slice(0, 10),
      recentArtifacts: artifacts.slice(0, 10),
      firstRunRequired: config === undefined,
      statePath: config?.stateDirectory ?? "",
      logPath: config === undefined
        ? ""
        : path.join(config.stateDirectory, "toolspan-service.log"),
      workspaces: config?.allowedRoots.map(workspaceRoot) ?? [],
      managedByDesktop: active !== undefined,
      nodeVersion: process.version,
      nodePathConfigured: true,
      ownerPasswordConfigured: config !== undefined,
      oauthDiscoveryUrl: config === undefined
        ? null
        : `${config.publicBaseUrl}/.well-known/oauth-authorization-server`,
      lastUpdatedAt: new Date(now()).toISOString(),
    };
  };

  const emitSnapshot = async (): Promise<void> => {
    try {
      emit({ event: "runtime.snapshot", data: await snapshot() });
    } catch {
      emit({ event: "runtime.attention", data: { code: "SNAPSHOT_UNAVAILABLE" } });
    }
  };

  const start = async (): Promise<RuntimeSnapshot> => {
    if (active !== undefined) return snapshot();
    state = "starting";
    await emitSnapshot();
    let runtime: Runtime | undefined;
    let phase: "config" | "runtime" | "listen" = "config";
    try {
      const config = await loadConfig(options.configPath);
      phase = "runtime";
      runtime = await createRuntime(config);
      phase = "listen";
      const server = runtime.app.listen(config.port, config.host);
      await once(server, "listening");
      active = { config, runtime, server };
      state = "running";
      appendLog("Runtime started");
      const result = await snapshot();
      emit({ event: "runtime.snapshot", data: result });
      return result;
    } catch (error) {
      if (runtime !== undefined) await runtime.close();
      state = "attention";
      appendLog(`Runtime failed to start [${phase === "config" ? "CONFIG_INVALID" : "RUNTIME_START_FAILED"}]`);
      emit({ event: "runtime.attention", data: { code: "START_FAILED" } });
      throw error;
    }
  };

  const stop = async (): Promise<RuntimeSnapshot> => {
    const owned = active;
    if (owned === undefined) {
      state = "stopped";
      return snapshot();
    }
    state = "stopping";
    await emitSnapshot();
    try {
      await closeServer(owned.server);
    } finally {
      await owned.runtime.close();
      active = undefined;
    }
    state = "stopped";
    appendLog("Runtime stopped");
    const result = await snapshot();
    emit({ event: "runtime.snapshot", data: result });
    return result;
  };

  const testConnection = async (target: "local" | "public"): Promise<ConnectionTestResult> => {
    const started = now();
    const config = await loadCurrentConfig();
    try {
      let response: ProbeResponse;
      if (target === "local") {
        response = await probeLocal(new URL("/healthz", loopbackBaseUrl(config)));
      } else {
        const configured = new URL(config.publicBaseUrl);
        if (
          configured.protocol !== "https:"
          || configured.username !== ""
          || configured.password !== ""
        ) {
          lastPublicReady = false;
          return {
            target,
            ok: false,
            status: null,
            latencyMs: Math.max(0, now() - started),
            service: null,
            version: null,
            error: "PUBLIC_TARGET_NOT_ALLOWED",
          };
        }
        const configuredOrigin = configured.origin;
        let current = new URL("/healthz", configured);
        let redirects = 0;
        while (true) {
          const addresses = await lookupAddresses(current.hostname);
          if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
            lastPublicReady = false;
            return {
              target,
              ok: false,
              status: null,
              latencyMs: Math.max(0, now() - started),
              service: null,
              version: null,
              error: "PUBLIC_TARGET_NOT_ALLOWED",
            };
          }
          const address = addresses[0];
          if (address === undefined) throw new Error("No public address");
          response = await probePublic(current, address);
          if (
            ![301, 302, 303, 307, 308].includes(response.status)
            || response.location === undefined
          ) break;
          if (redirects >= MAX_PUBLIC_REDIRECTS) throw new Error("Too many redirects");
          const redirected = new URL(response.location, current);
          if (
            redirected.protocol !== "https:"
            || redirected.origin !== configuredOrigin
            || redirected.username !== ""
            || redirected.password !== ""
          ) {
            lastPublicReady = false;
            return {
              target,
              ok: false,
              status: response.status,
              latencyMs: Math.max(0, now() - started),
              service: null,
              version: null,
              error: "PUBLIC_TARGET_NOT_ALLOWED",
            };
          }
          current = redirected;
          redirects += 1;
        }
      }
      const health = parseHealth(response);
      const ok = health !== undefined;
      if (target === "public") lastPublicReady = ok;
      return {
        target,
        ok,
        status: response.status,
        latencyMs: Math.max(0, now() - started),
        service: health?.service ?? null,
        version: health?.version ?? null,
        error: ok ? null : "INVALID_HEALTH_RESPONSE",
      };
    } catch {
      if (target === "public") lastPublicReady = false;
      return {
        target,
        ok: false,
        status: null,
        latencyMs: Math.max(0, now() - started),
        service: null,
        version: null,
        error: "CONNECTION_FAILED",
      };
    }
  };

  return {
    async invoke(method: DesktopServiceMethod, params: unknown): Promise<unknown> {
      const input = params as Record<string, unknown>;
      switch (method) {
        case "runtime.getSnapshot":
          return snapshot();
        case "runtime.start":
          return start();
        case "runtime.stop":
          return stop();
        case "runtime.restart":
          await stop();
          return start();
        case "runtime.validateConfig":
          try {
            return { valid: true, summary: summarizeConfig(await loadConfig(options.configPath)) };
          } catch {
            return { valid: false, error: "CONFIG_INVALID" };
          }
        case "runtime.getConfigSummary":
          return summarizeConfig(await loadCurrentConfig());
        case "runtime.listJobs": {
          if (active === undefined) throw new Error("Runtime is not running");
          const jobs = await active.runtime.services.jobs.listJobs(
            input.workspaceId as string | undefined,
            input.status as JobStatus | undefined,
          );
          return { jobs };
        }
        case "runtime.cancelJob":
          if (active === undefined) throw new Error("Runtime is not running");
          return active.runtime.services.jobs.cancelJob(input.jobId as string);
        case "runtime.listArtifacts":
          if (active === undefined) throw new Error("Runtime is not running");
          return {
            artifacts: await active.runtime.services.artifacts.listArtifacts(
              input.workspaceId as string | undefined,
            ),
          };
        case "runtime.getLogChunk": {
          await flushLogs();
          const logFiles = new Set<string>();
          const fileLogs: string[] = [];
          let hasLogFile = false;
          const readLogFile = async (filePath: string): Promise<void> => {
            if (logFiles.has(filePath)) return;
            logFiles.add(filePath);
            try {
              fileLogs.push(await readFile(filePath, "utf8"));
              hasLogFile = true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          };
          if (logPath !== undefined) await readLogFile(logPath);
          let config: ToolSpanConfig | undefined;
          try {
            config = await loadCurrentConfig();
          } catch {
            config = undefined;
          }
          if (config !== undefined) {
            for (const name of ["toolspan-service.log", "webgpt-service.log"]) {
              await readLogFile(path.join(config.stateDirectory, name));
              if (hasLogFile) break;
            }
          }
          if (!hasLogFile) fileLogs.push(safeLog.join(""));
          const content = Buffer.from(sanitizeLogs(fileLogs.join("")), "utf8");
          const cursor = Math.min(input.cursor as number | undefined ?? 0, content.length);
          const limit = input.limit as number | undefined ?? MAX_PROBE_BODY_BYTES;
          const chunk = content.subarray(cursor, cursor + limit);
          return {
            chunk: chunk.toString("utf8"),
            nextCursor: cursor + chunk.length,
            truncated: cursor + chunk.length < content.length,
          };
        }
        case "runtime.subscribeEvents":
          return { subscribed: input.enabled as boolean };
        case "connection.testLocal":
          return testConnection("local");
        case "connection.testPublic":
          return testConnection("public");
        case "setup.getSnapshot":
        case "setup.preflight":
        case "setup.plan":
        case "setup.apply":
        case "setup.rollback":
        case "setup.reconcile":
        case "setup.discardCredential":
          return (await loadSetupService()).invoke(method, params);
      }
    },
    subscribeEvents(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close(): Promise<void> {
      await stop();
      await flushLogs();
      listeners.clear();
    },
  };
}
