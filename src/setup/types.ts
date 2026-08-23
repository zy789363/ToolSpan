export const SETUP_PROTOCOL_VERSION = "1" as const;
export const SETUP_JOURNAL_VERSION = "1" as const;
export const SETUP_MANIFEST_SCHEMA_VERSION = "1.0" as const;
export const SETUP_RECEIPT_SCHEMA_VERSION = "1" as const;
export const SETUP_STATE_SCHEMA_VERSION = "1" as const;

export type SetupStatus =
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

export type DomainChoice =
  | "existing"
  | "other_registrar"
  | "namesilo_no_referral";

export interface SetupManifestDraft {
  toolSpanVersion: string;
  instanceName: string;
  localUrl: string;
  desiredHostname: string;
  publicMcpUrl: string;
  oauthDiscoveryUrl: string;
  expectedToolCount: 27;
  tunnelName: string;
  domainChoice: DomainChoice;
  officialDocs: string[];
}

export interface SetupManifest extends SetupManifestDraft {
  schemaVersion: typeof SETUP_MANIFEST_SCHEMA_VERSION;
  generatedAt: string;
}

export type ResourceClassification = "created" | "reused" | "updated" | "untouched";

export type SetupResourceKind =
  | "account"
  | "zone"
  | "tunnel"
  | "tunnel_config"
  | "dns"
  | "cloudflared"
  | "toolspan_config";

export interface SetupPlanAction {
  kind: SetupResourceKind;
  classification: ResourceClassification;
  resourceId?: string;
  name: string;
  beforeFingerprint?: string;
  desiredFingerprint: string;
  reason: string;
}

export interface SetupPlan {
  schemaVersion: "1";
  sessionId: string;
  account: { id: string; name: string };
  zone: { id: string; name: string; status: string; nameservers: string[] };
  actions: SetupPlanAction[];
  warnings: string[];
  confirmationRequired: true;
  plannedAt: string;
}

export interface SetupReceiptResource extends SetupPlanAction {
  resourceId: string;
  ownedBySession: boolean;
  afterFingerprint?: string;
}

export interface SetupVerificationEvidence {
  check: "tunnel_health" | "cloudflared" | "dns" | "public_endpoint" | "tool_contract";
  passed: boolean;
  checkedAt: string;
  detail?: string;
}

export interface SetupRollbackResource {
  kind: SetupResourceKind;
  resourceId: string;
  outcome: "removed" | "restored" | "skipped" | "failed";
  reason: string;
}

export interface SetupReceipt {
  schemaVersion: typeof SETUP_RECEIPT_SCHEMA_VERSION;
  sessionId: string;
  idempotencyKey: string;
  startedAt: string;
  completedAt?: string;
  resources: SetupReceiptResource[];
  verification: SetupVerificationEvidence[];
  rollback: {
    status: "not_started" | "full" | "partial";
    resources: SetupRollbackResource[];
  };
  duplicateCreates: number;
}

export type SetupBlockerCode =
  | "INVALID_CREDENTIAL"
  | "INSUFFICIENT_CREDENTIAL"
  | "ZONE_NOT_FOUND"
  | "ZONE_PENDING"
  | "ZONE_NOT_ACTIVE"
  | "TUNNEL_CONFLICT"
  | "DNS_CONFLICT"
  | "CONFIRMATION_REQUIRED"
  | "ACTIVE_SESSION"
  | "CREDENTIAL_REENTRY_REQUIRED"
  | "FINGERPRINT_MISMATCH"
  | "RECONCILIATION_REQUIRED"
  | "APPLY_FAILED"
  | "MANUAL_OR_UAC_REQUIRED"
  | "ROLLBACK_PARTIAL";

export interface SetupBlocker {
  code: SetupBlockerCode;
  message: string;
  nameservers?: string[];
}

export interface SetupSnapshot {
  setupProtocolVersion: typeof SETUP_PROTOCOL_VERSION;
  setupJournalVersion: typeof SETUP_JOURNAL_VERSION;
  setupManifestSchemaVersion: typeof SETUP_MANIFEST_SCHEMA_VERSION;
  setupReceiptSchemaVersion: typeof SETUP_RECEIPT_SCHEMA_VERSION;
  sessionId: string;
  target: { zoneName: string };
  status: SetupStatus;
  manifest: SetupManifest;
  plan?: SetupPlan;
  receipt?: SetupReceipt;
  blocker?: SetupBlocker;
  requiresCredential: boolean;
  updatedAt: string;
}

export interface SetupSessionRecord {
  sessionId: string;
  idempotencyKey: string;
  target: { zoneName: string };
  status: SetupStatus;
  plan?: SetupPlan;
  blocker?: SetupBlocker;
  requiresCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SetupStateDocument {
  schemaVersion: typeof SETUP_STATE_SCHEMA_VERSION;
  setupProtocolVersion: typeof SETUP_PROTOCOL_VERSION;
  updatedAt: string;
  currentSessionId?: string;
  sessions: Record<string, SetupSessionRecord>;
}

export type SetupJournalEvent =
  | "SESSION_CREATED"
  | "STATE_TRANSITION"
  | "PLAN_CREATED"
  | "APPLY_ACTION"
  | "APPLY_FAILED"
  | "RECONCILED"
  | "ROLLBACK_ACTION"
  | "STALE_LOCK_RECOVERED";

export interface SetupJournalEntry {
  sequence: number;
  at: string;
  event: SetupJournalEvent;
  from?: SetupStatus;
  to?: SetupStatus;
  resource?: Omit<SetupReceiptResource, "reason"> & { reason?: string };
  rollbackData?: {
    kind: "tunnel_config" | "dns";
    resourceId: string;
    accountId?: string;
    zoneId?: string;
    previousTunnelConfig?: import("./cloudflare-adapter.js").CloudflareTunnelConfig;
    previousDnsRecord?: import("./cloudflare-adapter.js").CloudflareDnsRecord;
    appliedFingerprint: string;
  };
  detail?: string;
}

export interface SetupJournal {
  schemaVersion: typeof SETUP_JOURNAL_VERSION;
  sessionId: string;
  idempotencyKey: string;
  entries: SetupJournalEntry[];
}

export interface SetupLock {
  schemaVersion: "1";
  sessionId: string;
  status: "APPLYING" | "ROLLING_BACK";
  pid: number;
  acquiredAt: string;
}

export class SetupError extends Error {
  readonly code: SetupBlockerCode;
  readonly blocker: SetupBlocker;

  constructor(blocker: SetupBlocker, options?: ErrorOptions) {
    super(blocker.message, options);
    this.name = "SetupError";
    this.code = blocker.code;
    this.blocker = blocker;
  }
}
