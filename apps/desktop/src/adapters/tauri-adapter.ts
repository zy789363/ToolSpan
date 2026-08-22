import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { z } from "zod";

import {
  DesktopAdapterError,
  type ConnectionTestResult,
  type DesktopAdapter,
  type DesktopArtifact,
  type DesktopJob,
  type DesktopLogEntry,
  type FirstRunInput,
  type JobFilter,
  type LogFilter,
  type LogLevel,
  type RuntimeSnapshot,
  type SetupCredential,
  type SetupSafeManifest,
  type SetupSnapshot,
  type WorkspaceRoot,
} from "./types";

const workspaceSchema = z.object({
  id: z.string(), name: z.string(), path: z.string(), access: z.enum(["read", "read-write"]),
});
const rawJobSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  runner: z.string(),
  args: z.array(z.string()),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled", "timed_out", "interrupted"]),
  pid: z.number().int().nullable(),
  exitCode: z.number().int().nullable(),
  error: z.string().nullable(),
  logPath: z.string(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
const rawArtifactSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  profile: z.enum(["workspace_snapshot", "git_diff", "job_output"]),
  jobId: z.string().nullable(),
  filePath: z.string(),
  mediaType: z.string(),
  size: z.number().nonnegative(),
  sha256: z.string(),
  createdAt: z.string(),
  publishedSlug: z.string().nullable(),
});
const rawSnapshotSchema = z.object({
  state: z.enum(["stopped", "starting", "running", "stopping", "attention"]),
  productVersion: z.string(),
  instanceName: z.string().nullable(),
  localEndpoint: z.string().nullable(),
  publicBaseUrl: z.string().nullable(),
  mcpTools: z.object({ available: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  uptimeSeconds: z.number().int().nonnegative().nullable(),
  localReady: z.boolean(),
  publicReady: z.boolean().nullable(),
  recentJobs: z.array(rawJobSchema),
  recentArtifacts: z.array(rawArtifactSchema),
  firstRunRequired: z.boolean().optional(),
  statePath: z.string().optional(),
  logPath: z.string().optional(),
  workspaces: z.array(workspaceSchema).optional(),
  managedByDesktop: z.boolean().optional(),
  nodeVersion: z.string().nullable().optional(),
  nodePathConfigured: z.boolean().optional(),
  ownerPasswordConfigured: z.boolean().optional(),
  oauthDiscoveryUrl: z.string().nullable().optional(),
  lastUpdatedAt: z.string().optional(),
});
const unifiedSnapshotSchema = z.object({
  firstRunRequired: z.boolean(),
  instanceName: z.string(),
  core: z.object({
    state: z.enum(["running", "starting", "stopped", "attention", "external", "unavailable"]),
    version: z.string(),
    managedByDesktop: z.boolean(),
    uptimeSeconds: z.number().int().nonnegative().nullable(),
    nodeVersion: z.string().nullable(),
    nodePathConfigured: z.boolean(),
  }).strict(),
  connection: z.object({
    localUrl: z.string(),
    publicBaseUrl: z.string().nullable(),
    oauthDiscoveryUrl: z.string().nullable(),
    localReady: z.boolean(),
    publicReady: z.boolean().nullable(),
  }).strict(),
  toolContract: z.object({ available: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
  workspaces: z.array(workspaceSchema),
  recentJobs: z.array(rawJobSchema),
  recentArtifacts: z.array(rawArtifactSchema),
  statePath: z.string(),
  logPath: z.string(),
  ownerPasswordConfigured: z.boolean(),
  lastUpdatedAt: z.string(),
}).strict();
const jobsEnvelopeSchema = z.object({ jobs: z.array(rawJobSchema) });
const artifactsEnvelopeSchema = z.object({ artifacts: z.array(rawArtifactSchema) });
const logChunkSchema = z.object({ chunk: z.string(), nextCursor: z.number().int().nonnegative(), truncated: z.boolean() });
const connectionResultSchema = z.object({
  target: z.enum(["local", "public"]),
  ok: z.boolean(),
  status: z.union([z.number(), z.string(), z.null()]),
  latencyMs: z.number().nonnegative(),
  service: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  checkedUrl: z.string().optional(),
  checkedAt: z.string().optional(),
});
const setupSafeManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  toolSpanVersion: z.string().min(1),
  instanceName: z.string(),
  localUrl: z.string(),
  desiredHostname: z.string(),
  publicMcpUrl: z.string(),
  oauthDiscoveryUrl: z.string(),
  expectedToolCount: z.literal(27),
  tunnelName: z.string(),
  domainChoice: z.enum(["existing", "other_registrar", "namesilo_referral", "namesilo_no_referral"]),
  officialDocs: z.array(z.string()),
  generatedAt: z.string(),
}).strict();
const setupStatusSchema = z.enum([
    "IDLE", "PREFLIGHT", "PLANNED", "WAITING_FOR_CONFIRMATION", "APPLYING", "VERIFYING", "COMPLETE",
    "NEEDS_CREDENTIAL_REENTRY", "NEEDS_RECONCILIATION", "ROLLING_BACK", "ROLLED_BACK", "ROLLBACK_PARTIAL",
]);
const setupPlanActionSchema = z.object({
  kind: z.enum(["account", "zone", "tunnel", "tunnel_config", "dns", "cloudflared", "toolspan_config"]),
  classification: z.enum(["created", "reused", "updated", "untouched"]),
  resourceId: z.string().optional(),
  name: z.string(),
  beforeFingerprint: z.string().optional(),
  desiredFingerprint: z.string(),
  reason: z.string(),
}).strict();
const setupPlanSchema = z.object({
  schemaVersion: z.literal("1"),
  sessionId: z.string(),
  account: z.object({ id: z.string(), name: z.string() }).strict(),
  zone: z.object({ id: z.string(), name: z.string(), status: z.string(), nameservers: z.array(z.string()) }).strict(),
  actions: z.array(setupPlanActionSchema),
  warnings: z.array(z.string()),
  confirmationRequired: z.literal(true),
  plannedAt: z.string(),
}).strict();
const setupReceiptResourceSchema = setupPlanActionSchema.extend({
  resourceId: z.string(),
  ownedBySession: z.boolean(),
  afterFingerprint: z.string().optional(),
}).strict();
const setupReceiptSchema = z.object({
  schemaVersion: z.literal("1"),
  sessionId: z.string(),
  idempotencyKey: z.string(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  resources: z.array(setupReceiptResourceSchema),
  verification: z.array(z.object({
    check: z.enum(["tunnel_health", "cloudflared", "dns", "public_endpoint", "tool_contract"]),
    passed: z.boolean(),
    checkedAt: z.string(),
    detail: z.string().optional(),
  }).strict()),
  rollback: z.object({
    status: z.enum(["not_started", "full", "partial"]),
    resources: z.array(z.object({
      kind: z.enum(["account", "zone", "tunnel", "tunnel_config", "dns", "cloudflared", "toolspan_config"]),
      resourceId: z.string(),
      outcome: z.enum(["removed", "restored", "skipped", "failed"]),
      reason: z.string(),
    }).strict()),
  }).strict(),
  duplicateCreates: z.number().int().nonnegative(),
}).strict();
const rawSetupSnapshotSchema = z.object({
  setupProtocolVersion: z.literal("1"),
  setupJournalVersion: z.literal("1"),
  setupManifestSchemaVersion: z.literal("1.0"),
  setupReceiptSchemaVersion: z.literal("1"),
  sessionId: z.string(),
  target: z.object({ zoneName: z.string() }).strict(),
  status: setupStatusSchema,
  manifest: setupSafeManifestSchema,
  plan: setupPlanSchema.optional(),
  receipt: setupReceiptSchema.optional(),
  blocker: z.object({
    code: z.enum([
      "INVALID_CREDENTIAL", "INSUFFICIENT_CREDENTIAL", "GLOBAL_KEY_EMAIL_MISMATCH", "ZONE_NOT_FOUND", "ZONE_PENDING",
      "ZONE_NOT_ACTIVE", "TUNNEL_CONFLICT", "DNS_CONFLICT", "CONFIRMATION_REQUIRED", "ACTIVE_SESSION",
      "CREDENTIAL_REENTRY_REQUIRED", "FINGERPRINT_MISMATCH", "RECONCILIATION_REQUIRED", "APPLY_FAILED", "ROLLBACK_PARTIAL",
    ]),
    message: z.string(),
    nameservers: z.array(z.string()).optional(),
  }).strict().optional(),
  requiresCredential: z.boolean(),
  updatedAt: z.string(),
}).strict();
const setupCredentialResultSchema = z.object({ accepted: z.literal(true), credentialKind: z.enum(["api_token", "global_api_key"]) }).strict();
const setupDiscardResultSchema = z.object({ discarded: z.literal(true), sessionId: z.string().min(1) }).strict();
const responseSchema = z.discriminatedUnion("ok", [
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string().nullable(), ok: z.literal(false), error: z.object({ code: z.string() }).passthrough() }),
]);
const quitRequestSchema = z.object({ managedCore: z.boolean() });

type RawJob = z.infer<typeof rawJobSchema>;
type RawArtifact = z.infer<typeof rawArtifactSchema>;

async function protocolCall(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const raw = await invoke<unknown>("desktop_invoke", {
    request: { id: globalThis.crypto.randomUUID(), method, params },
  });
  const response = responseSchema.safeParse(raw);
  if (!response.success) throw new DesktopAdapterError("DESKTOP_RESPONSE_INVALID");
  if (!response.data.ok) throw new DesktopAdapterError(response.data.error.code);
  return response.data.result;
}

async function rustCall<T>(command: string, arguments_: InvokeArgs = {}): Promise<T> {
  try {
    return await invoke<T>(command, arguments_);
  } catch {
    throw new DesktopAdapterError("LOCAL_DESKTOP_OPERATION_FAILED");
  }
}

function artifactName(filePath: string): string {
  return filePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? "artifact";
}

function publicArtifactUrl(base: string | null, slug: string | null): string | undefined {
  if (base === null || slug === null) return undefined;
  try {
    return new URL(`/artifacts/published/${encodeURIComponent(slug)}`, base).toString();
  } catch {
    return undefined;
  }
}

export function mapDesktopJob(raw: RawJob): DesktopJob {
  return {
    id: raw.id,
    label: raw.runner,
    runner: raw.runner,
    status: raw.status,
    createdAt: raw.createdAt,
    ...(raw.finishedAt === null ? {} : { finishedAt: raw.finishedAt }),
  };
}

export function mapDesktopArtifact(raw: RawArtifact, publicBaseUrl: string | null): DesktopArtifact {
  const publicUrl = publicArtifactUrl(publicBaseUrl, raw.publishedSlug);
  return {
    id: raw.id,
    name: artifactName(raw.filePath),
    mediaType: raw.mediaType,
    sizeBytes: raw.size,
    createdAt: raw.createdAt,
    localPath: raw.filePath,
    ...(publicUrl === undefined ? {} : { publicUrl }),
  };
}

export function mapRuntimeSnapshot(value: unknown): RuntimeSnapshot {
  const unified = unifiedSnapshotSchema.safeParse(value);
  if (unified.success) {
    const raw = unified.data;
    return {
      ...raw,
      recentJobs: raw.recentJobs.map(mapDesktopJob),
      recentArtifacts: raw.recentArtifacts.map((artifact) => mapDesktopArtifact(artifact, raw.connection.publicBaseUrl)),
    };
  }
  const parsed = rawSnapshotSchema.safeParse(value);
  if (!parsed.success) throw new DesktopAdapterError("RUNTIME_SNAPSHOT_INVALID");
  const raw = parsed.data;
  return {
    firstRunRequired: raw.firstRunRequired ?? raw.instanceName === null,
    instanceName: raw.instanceName ?? "",
    core: {
      state: raw.state,
      version: raw.productVersion,
      managedByDesktop: raw.managedByDesktop ?? false,
      uptimeSeconds: raw.uptimeSeconds,
      nodeVersion: raw.nodeVersion ?? null,
      nodePathConfigured: raw.nodePathConfigured ?? false,
    },
    connection: {
      localUrl: raw.localEndpoint,
      publicBaseUrl: raw.publicBaseUrl,
      oauthDiscoveryUrl: raw.oauthDiscoveryUrl ?? null,
      localReady: raw.localReady,
      publicReady: raw.publicReady,
    },
    toolContract: raw.mcpTools,
    workspaces: raw.workspaces ?? [],
    recentJobs: raw.recentJobs.map(mapDesktopJob),
    recentArtifacts: raw.recentArtifacts.map((artifact) => mapDesktopArtifact(artifact, raw.publicBaseUrl)),
    statePath: raw.statePath ?? "",
    logPath: raw.logPath ?? "",
    ownerPasswordConfigured: raw.ownerPasswordConfigured ?? false,
    lastUpdatedAt: raw.lastUpdatedAt ?? new Date().toISOString(),
  };
}

function mapConnectionResult(value: unknown, configuredUrl: string | null): ConnectionTestResult {
  const parsed = connectionResultSchema.safeParse(value);
  if (!parsed.success) throw new DesktopAdapterError("CONNECTION_RESULT_INVALID");
  const raw = parsed.data;
  return {
    target: raw.target,
    ok: raw.ok,
    latencyMs: raw.latencyMs,
    status: raw.ok ? "READY" : (raw.error ?? (raw.status === null ? "FAILED" : String(raw.status))),
    checkedUrl: raw.checkedUrl ?? configuredUrl,
    checkedAt: raw.checkedAt ?? new Date().toISOString(),
  };
}

function mapSetupSnapshot(value: unknown): SetupSnapshot {
  const parsed = rawSetupSnapshotSchema.safeParse(value);
  if (!parsed.success) throw new DesktopAdapterError("SETUP_SNAPSHOT_INVALID");
  const raw = parsed.data;
  const plannedZone = raw.plan?.zone;
  const blockerCode = raw.blocker?.code;
  const normalizedPlanStatus = plannedZone?.status.toLowerCase();
  const zoneStatus = blockerCode === "ZONE_NOT_FOUND"
    ? "missing"
    : blockerCode === "ZONE_PENDING" || blockerCode === "ZONE_NOT_ACTIVE"
      ? "pending"
      : normalizedPlanStatus === "active"
        ? "active"
        : normalizedPlanStatus?.includes("pending") === true
          ? "pending"
          : "unknown";
  const rollbackResources = raw.receipt?.rollback.resources ?? [];
  const rollback = raw.receipt === undefined ? null : {
    status: raw.receipt.rollback.status,
    remainingResources: rollbackResources
      .filter((resource) => resource.outcome === "skipped" || resource.outcome === "failed")
      .map((resource) => `${resource.kind}: ${resource.resourceId}`),
    manualSteps: rollbackResources
      .filter((resource) => resource.outcome === "skipped" || resource.outcome === "failed")
      .map((resource) => resource.reason),
  };
  return {
    sessionId: raw.sessionId,
    phase: raw.status,
    path: null,
    domain: raw.target.zoneName,
    desiredHostname: raw.manifest.desiredHostname,
    zone: {
      exists: plannedZone !== undefined || blockerCode === "ZONE_PENDING" || blockerCode === "ZONE_NOT_ACTIVE",
      status: zoneStatus,
      accountId: raw.plan?.account.id ?? null,
      zoneId: plannedZone?.id ?? null,
      assignedNameservers: plannedZone?.nameservers ?? raw.blocker?.nameservers ?? [],
    },
    plan: raw.plan === undefined ? null : {
      sideEffectsApplied: false,
      warnings: raw.plan.warnings,
      items: raw.plan.actions.map((action, index) => ({
        id: action.resourceId ?? `${action.kind}-${String(index)}`,
        resource: action.name,
        disposition: action.classification,
        summary: action.reason,
      })),
    },
    rollback,
    verificationEvidence: raw.receipt?.verification.map((evidence) => ({
      check: evidence.check,
      passed: evidence.passed,
      detail: evidence.detail ?? null,
    })) ?? [],
    duplicateCreates: raw.receipt?.duplicateCreates ?? null,
    requiresCredential: raw.requiresCredential,
    safeManifest: raw.manifest,
    chatGptStatus: "MANUAL_PENDING",
    guideCurrent: false,
    commercialOffer: { current: false, example: null, coupon: null },
    vendorAssets: "text_only_fallback",
    lastErrorCode: raw.blocker?.code ?? null,
  };
}

function parseLogChunk(value: unknown, filter?: LogFilter): DesktopLogEntry[] {
  const parsed = logChunkSchema.safeParse(value);
  if (!parsed.success) throw new DesktopAdapterError("LOG_CHUNK_INVALID");
  return parsed.data.chunk.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    const timestamp = /^(\d{4}-\d{2}-\d{2}T\S+)\s+/u.exec(line)?.[1];
    const levelMatch = /\b(debug|info|warn|error)\b/iu.exec(line)?.[1]?.toLowerCase();
    const level: LogLevel = levelMatch === "debug" || levelMatch === "warn" || levelMatch === "error" ? levelMatch : "info";
    return {
      id: `log-${String(filter?.cursor ?? 0)}-${String(index)}`,
      timestamp: timestamp ?? new Date(0).toISOString(),
      level,
      source: "core",
      message: line,
    };
  }).filter((entry) => {
    const levelMatches = filter?.level === undefined || entry.level === filter.level;
    const queryMatches = filter?.query === undefined || entry.message.toLowerCase().includes(filter.query.toLowerCase());
    return levelMatches && queryMatches;
  });
}

export function createTauriDesktopAdapter(): DesktopAdapter {
  let lastSnapshot: RuntimeSnapshot | null = null;
  return {
    async getSnapshot() {
      const snapshot = mapRuntimeSnapshot(await protocolCall("runtime.getSnapshot"));
      lastSnapshot = snapshot;
      return snapshot;
    },
    async start() { await protocolCall("runtime.start"); },
    async stop() { await protocolCall("runtime.stop"); },
    async restart() { await protocolCall("runtime.restart"); },
    async testLocal() { return mapConnectionResult(await protocolCall("connection.testLocal"), lastSnapshot?.connection.localUrl ?? null); },
    async testPublic() { return mapConnectionResult(await protocolCall("connection.testPublic"), lastSnapshot?.connection.publicBaseUrl ?? null); },
    pickAllowedRoot: () => rustCall<WorkspaceRoot | null>("pick_allowed_root"),
    async removeAllowedRoot(id) { await rustCall<void>("remove_allowed_root", { id }); },
    async listJobs(filter?: JobFilter) {
      const value = await protocolCall("runtime.listJobs", filter?.status === undefined ? {} : { status: filter.status });
      const parsed = jobsEnvelopeSchema.safeParse(value);
      if (!parsed.success) throw new DesktopAdapterError("JOBS_RESULT_INVALID");
      return parsed.data.jobs.map(mapDesktopJob).filter((job) => filter?.query === undefined || job.label.toLowerCase().includes(filter.query.toLowerCase()));
    },
    async cancelJob(id) { await protocolCall("runtime.cancelJob", { jobId: id }); },
    async listArtifacts() {
      const parsed = artifactsEnvelopeSchema.safeParse(await protocolCall("runtime.listArtifacts"));
      if (!parsed.success) throw new DesktopAdapterError("ARTIFACTS_RESULT_INVALID");
      return parsed.data.artifacts.map((artifact) => mapDesktopArtifact(artifact, lastSnapshot?.connection.publicBaseUrl ?? null));
    },
    async getLogs(filter?: LogFilter) {
      return parseLogChunk(await protocolCall("runtime.getLogChunk", { cursor: filter?.cursor ?? 0, limit: 65536 }), filter);
    },
    hashOwnerPassword: (password) => rustCall<string>("hash_owner_password", { password }),
    async completeFirstRun(input: FirstRunInput) { await rustCall<void>("complete_first_run", { input }); },
    async updateOwnerPasswordHash(hash) { await rustCall<void>("update_owner_password_hash", { hash }); },
    async chooseNodeExecutable() { await rustCall<void>("choose_node_executable"); },
    async getSetupSnapshot(sessionId) {
      const value = await protocolCall("setup.getSnapshot", sessionId === undefined ? {} : { sessionId });
      return value === null ? null : mapSetupSnapshot(value);
    },
    async setSetupCredential(sessionId: string, credential: SetupCredential) {
      const result = setupCredentialResultSchema.safeParse(await rustCall<unknown>("setup_set_credential", { input: { sessionId, credential } }));
      if (!result.success) throw new DesktopAdapterError("SETUP_CREDENTIAL_RESULT_INVALID");
    },
    async setupPreflight(sessionId: string, idempotencyKey: string, zoneName: string, manifest: SetupSafeManifest) {
      return mapSetupSnapshot(await protocolCall("setup.preflight", { sessionId, idempotencyKey, zoneName, manifest }));
    },
    async setupPlan(sessionId) { return mapSetupSnapshot(await protocolCall("setup.plan", { sessionId })); },
    async setupApply(sessionId) { return mapSetupSnapshot(await protocolCall("setup.apply", { sessionId, confirmation: "APPLY" })); },
    async setupRollback(sessionId) { return mapSetupSnapshot(await protocolCall("setup.rollback", { sessionId, confirmation: "ROLLBACK" })); },
    async setupReconcile(sessionId) { return mapSetupSnapshot(await protocolCall("setup.reconcile", { sessionId })); },
    async discardSetupCredential(sessionId) {
      const result = setupDiscardResultSchema.safeParse(await protocolCall("setup.discardCredential", { sessionId }));
      if (!result.success) throw new DesktopAdapterError("SETUP_DISCARD_RESULT_INVALID");
    },
    async onTrayAction(handler) {
      const removeCopyListener = await listen("tray://copy-mcp-url", () => handler("copy-mcp-url"));
      const removeOpenLogsListener = await listen("tray://open-logs", () => handler("open-logs"));
      return () => {
        removeCopyListener();
        removeOpenLogsListener();
      };
    },
    async onQuitRequested(handler) {
      return listen<unknown>("tray://quit-requested", (event) => {
        const payload = quitRequestSchema.safeParse(event.payload);
        if (payload.success) handler(payload.data.managedCore);
      });
    },
    async confirmQuit(stopManaged) { await rustCall<void>("confirm_quit", { stopManaged }); },
  };
}
