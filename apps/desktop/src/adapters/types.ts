export type PageId =
  | "overview"
  | "setup"
  | "connection"
  | "workspaces"
  | "jobs"
  | "artifacts"
  | "logs"
  | "settings";

export type TrayAction = "copy-mcp-url" | "open-logs";

export type CoreState =
  | "running"
  | "starting"
  | "stopping"
  | "stopped"
  | "attention"
  | "external"
  | "unavailable";

export interface WorkspaceRoot {
  id: string;
  name: string;
  path: string;
  access: "read" | "read-write";
}

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export interface DesktopJob {
  id: string;
  label: string;
  runner: string;
  status: JobStatus;
  createdAt: string;
  finishedAt?: string;
  sanitizedOutput?: string;
}

export interface DesktopArtifact {
  id: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
  localPath: string;
  publicUrl?: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface DesktopLogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  source: string;
  message: string;
}

export interface RuntimeSnapshot {
  firstRunRequired: boolean;
  instanceName: string;
  core: {
    state: CoreState;
    version: string;
    managedByDesktop: boolean;
    uptimeSeconds: number | null;
    nodeVersion: string | null;
    nodePathConfigured: boolean;
  };
  connection: {
    localUrl: string | null;
    publicBaseUrl: string | null;
    oauthDiscoveryUrl: string | null;
    localReady: boolean;
    publicReady: boolean | null;
  };
  toolContract: {
    available: number;
    total: number;
  };
  workspaces: WorkspaceRoot[];
  recentJobs: DesktopJob[];
  recentArtifacts: DesktopArtifact[];
  statePath: string;
  logPath: string;
  ownerPasswordConfigured: boolean;
  lastUpdatedAt: string;
}

export interface ConnectionTestResult {
  target: "local" | "public";
  ok: boolean;
  latencyMs: number;
  status: string;
  checkedUrl: string | null;
  checkedAt: string;
}

export interface JobFilter {
  status?: JobStatus;
  query?: string;
}

export interface LogFilter {
  level?: LogLevel;
  query?: string;
  cursor?: number;
}

export interface FirstRunInput {
  instanceName: string;
  allowedRoots: Array<Pick<WorkspaceRoot, "name" | "path" | "access">>;
  statePath: string;
  logPath: string;
  ownerPasswordHash: string;
  startAfterSave: boolean;
}

export type SetupPath =
  | "guided_manual"
  | "scoped_api_token"
  | "agent_assisted";

export type SetupPhase =
  | "IDLE"
  | "PREFLIGHT"
  | "PLANNED"
  | "WAITING_FOR_CONFIRMATION"
  | "APPLYING"
  | "VERIFYING"
  | "COMPLETE"
  | "NEEDS_CREDENTIAL_REENTRY"
  | "NEEDS_RECONCILIATION"
  | "ROLLING_BACK"
  | "ROLLED_BACK"
  | "ROLLBACK_PARTIAL";

export type SetupResourceDisposition = "created" | "reused" | "updated" | "untouched";

export type SetupChatGptStatus =
  | "MANUAL_PENDING"
  | "USER_CONFIRMED"
  | "VALIDATED"
  | "BLOCKED_BY_HOST_PLAN_OR_POLICY";

export interface SetupZoneStatus {
  exists: boolean;
  status: "active" | "pending" | "missing" | "unknown";
  accountId: string | null;
  zoneId: string | null;
  assignedNameservers: string[];
}

export interface SetupPlanItem {
  id: string;
  resource: string;
  disposition: SetupResourceDisposition;
  summary: string;
}

export interface SetupPlan {
  items: SetupPlanItem[];
  sideEffectsApplied: false;
  warnings: string[];
}

export interface SetupRollbackStatus {
  status: "not_started" | "full" | "partial";
  remainingResources: string[];
  manualSteps: string[];
}

export interface SetupSafeManifest {
  schemaVersion: "1.0";
  toolSpanVersion: string;
  instanceName: string;
  localUrl: string;
  desiredHostname: string;
  publicMcpUrl: string;
  oauthDiscoveryUrl: string;
  expectedToolCount: 27;
  tunnelName: string;
  domainChoice: "existing" | "other_registrar" | "namesilo_no_referral";
  officialDocs: string[];
  generatedAt: string;
}

export interface SetupSnapshot {
  sessionId: string;
  phase: SetupPhase;
  path: SetupPath | null;
  domain: string;
  desiredHostname: string;
  zone: SetupZoneStatus;
  plan: SetupPlan | null;
  rollback: SetupRollbackStatus | null;
  verificationEvidence: Array<{ check: string; passed: boolean; detail: string | null }>;
  duplicateCreates: number | null;
  requiresCredential: boolean;
  safeManifest: SetupSafeManifest;
  chatGptStatus: SetupChatGptStatus;
  guideCurrent: boolean;
  commercialOffer: {
    current: boolean;
    example: string | null;
    coupon: string | null;
  };
  vendorAssets: "verified" | "text_only_fallback";
  lastErrorCode: string | null;
}

export type SetupCredential = { kind: "api_token"; token: string };

export interface DesktopAdapter {
  getSnapshot(): Promise<RuntimeSnapshot>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  testLocal(): Promise<ConnectionTestResult>;
  testPublic(): Promise<ConnectionTestResult>;
  pickAllowedRoot(): Promise<WorkspaceRoot | null>;
  removeAllowedRoot(id: string): Promise<void>;
  listJobs(filter?: JobFilter): Promise<DesktopJob[]>;
  cancelJob(id: string): Promise<void>;
  listArtifacts(): Promise<DesktopArtifact[]>;
  getLogs(filter?: LogFilter): Promise<DesktopLogEntry[]>;
  hashOwnerPassword(password: string): Promise<string>;
  completeFirstRun(input: FirstRunInput): Promise<void>;
  updateOwnerPasswordHash(hash: string): Promise<void>;
  chooseNodeExecutable(): Promise<void>;
  getSetupSnapshot(sessionId?: string): Promise<SetupSnapshot | null>;
  setSetupCredential(sessionId: string, credential: SetupCredential): Promise<void>;
  setupPreflight(sessionId: string, idempotencyKey: string, zoneName: string, manifest: SetupSafeManifest): Promise<SetupSnapshot>;
  setupPlan(sessionId: string): Promise<SetupSnapshot>;
  setupApply(sessionId: string): Promise<SetupSnapshot>;
  setupRollback(sessionId: string): Promise<SetupSnapshot>;
  setupReconcile(sessionId: string): Promise<SetupSnapshot>;
  discardSetupCredential(sessionId: string): Promise<void>;
  onTrayAction(handler: (action: TrayAction) => void): Promise<() => void>;
  onQuitRequested(handler: (managedCore: boolean) => void): Promise<() => void>;
  /** Tells the shell the quit dialog is reachable, disarming its quit deadline. */
  acknowledgeQuitRequest(): Promise<void>;
  confirmQuit(stopManaged: boolean): Promise<void>;
}

export class DesktopAdapterError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Desktop operation failed");
    this.name = "DesktopAdapterError";
    this.code = code;
  }
}
