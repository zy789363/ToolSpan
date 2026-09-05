import { createHash } from "node:crypto";

import type {
  CloudflareAccount,
  CloudflareAdapter,
  CloudflareCredential,
  CloudflareDnsRecord,
  CloudflareTunnel,
  CloudflareTunnelConfig,
  CloudflareZone,
} from "./cloudflare-adapter.js";
import { validateCredential } from "./cloudflare-adapter.js";
import type { CloudflaredAdapter } from "./cloudflared-adapter.js";
import { credentialSecrets } from "./redaction.js";
import { redactText } from "./redaction.js";
import { assertTransition } from "./state-machine.js";
import { operatingSystemProcessInspector, type ProcessInspector, SetupStore } from "./setup-store.js";
import {
  SETUP_JOURNAL_VERSION,
  SETUP_MANIFEST_SCHEMA_VERSION,
  SETUP_PROTOCOL_VERSION,
  SETUP_RECEIPT_SCHEMA_VERSION,
  SetupError,
  type SetupBlocker,
  type SetupJournal,
  type SetupJournalEntry,
  type SetupLock,
  type SetupManifest,
  type SetupManifestDraft,
  type SetupPlan,
  type SetupPlanAction,
  type SetupReceipt,
  type SetupReceiptResource,
  type SetupResourceKind,
  type SetupRollbackResource,
  type SetupSessionRecord,
  type SetupSnapshot,
  type SetupStatus,
} from "./types.js";

// =============================================================================
// Public API
// =============================================================================

export interface SetupServiceOptions {
  directory: string;
  cloudflare: CloudflareAdapter;
  cloudflared: CloudflaredAdapter;
  /** Applies the manifest's public URL origin to the Core config atomically. */
  writePublicMcpOrigin: (origin: string) => Promise<void>;
  /** Reads the currently configured Core public URL for reconciliation/rollback. */
  readPublicMcpOrigin?: () => Promise<string>;
  now?: () => Date;
  pid?: number;
  processInspector?: ProcessInspector;
}

export interface SetupService {
  /** Returns the current snapshot for the selected (or active) session, if any. */
  snapshot(input?: { sessionId?: string }): Promise<SetupSnapshot | undefined>;
  /** Creates a new session: validates inputs, verifies the credential, and persists the manifest + journal. */
  preflight(input: { sessionId: string; idempotencyKey: string; zoneName: string; manifest: SetupManifestDraft; credential: CloudflareCredential }): Promise<SetupSnapshot>;
  /** Dry-runs the domain transaction and produces a plan that requires confirmation. */
  plan(input: { sessionId: string }): Promise<SetupSnapshot>;
  /** Applies the planned domain transaction, then verifies tunnel + service health. */
  apply(input: { sessionId: string; confirmation: "APPLY"; credential?: CloudflareCredential }): Promise<SetupSnapshot>;
  /** Reverts every resource this session created or updated, in reverse apply order. */
  rollback(input: { sessionId: string; confirmation: "ROLLBACK"; credential?: CloudflareCredential }): Promise<SetupSnapshot>;
  /** Compares remote resources against the Apply journal and re-verifies health when they match. */
  reconcile(input: { sessionId: string; credential?: CloudflareCredential }): Promise<SetupSnapshot>;
  /** Drops the in-memory credential for a session (marks it as needing re-entry). */
  discard(input: { sessionId: string }): Promise<void>;
}

// =============================================================================
// Service factory
// =============================================================================

export function createSetupService(options: SetupServiceOptions): SetupService {
  const store = new SetupStore(options.directory);
  const now = options.now ?? (() => new Date());
  const processInspector = options.processInspector ?? operatingSystemProcessInspector;
  const pid = options.pid ?? process.pid;
  const credentialCache = new Map<string, CloudflareCredential>();
  let initialization: Promise<void> | undefined;

  /** ISO-8601 timestamp for journaling and record fields. */
  const timestamp = (): string => now().toISOString();

  const initialize = async (): Promise<void> => {
    initialization ??= (async () => {
      const at = timestamp();
      await store.initialize(at);
      const stale = await recoverVerifiedStaleLock(store, processInspector, at);
      const lock = await store.readLock();
      const state = await store.readState();
      for (const record of Object.values(state.sessions)) {
        const needsStartupCredential =
          record.status === "PREFLIGHT" ||
          record.status === "NEEDS_RECONCILIATION" ||
          record.status === "VERIFYING" ||
          ((record.status === "APPLYING" || record.status === "ROLLING_BACK") &&
            (lock === undefined || lock.sessionId !== record.sessionId));
        if (!needsStartupCredential || stale?.sessionId === record.sessionId) continue;
        record.blocker = {
          code: "CREDENTIAL_REENTRY_REQUIRED",
          message: "The host restarted and the in-memory Cloudflare credential is unavailable",
        };
        await writeTransition(
          record,
          "NEEDS_CREDENTIAL_REENTRY",
          at,
          undefined,
          "Credential cache is intentionally process-local",
        );
      }
    })();
    await initialization;
  };

  // ---------------------------------------------------------------------------
  // Shared mutation scaffolding
  // ---------------------------------------------------------------------------

  const getSnapshot = async (sessionId?: string): Promise<SetupSnapshot | undefined> => {
    await initialize();
    const state = await store.readState();
    const selectedId = sessionId ?? state.currentSessionId;
    if (selectedId === undefined) return undefined;
    const record = state.sessions[selectedId];
    const manifest = await store.readManifest(selectedId);
    if (record === undefined || manifest === undefined) return undefined;
    return {
      setupProtocolVersion: SETUP_PROTOCOL_VERSION,
      setupJournalVersion: SETUP_JOURNAL_VERSION,
      setupManifestSchemaVersion: SETUP_MANIFEST_SCHEMA_VERSION,
      setupReceiptSchemaVersion: SETUP_RECEIPT_SCHEMA_VERSION,
      sessionId: selectedId,
      target: record.target,
      status: record.status,
      manifest,
      ...(record.plan === undefined ? {} : { plan: record.plan }),
      ...((await store.readReceipt(selectedId)) === undefined
        ? {}
        : { receipt: await store.readReceipt(selectedId) }),
      ...(record.blocker === undefined ? {} : { blocker: record.blocker }),
      requiresCredential: record.requiresCredential,
      updatedAt: record.updatedAt,
    };
  };

  const snapshotOrThrow = async (sessionId: string): Promise<SetupSnapshot> => (await getSnapshot(sessionId))!;

  /**
   * Persists a state transition together with its journal entry.
   * `from` is captured from the record's current status, so call it before mutating anything else.
   */
  const writeTransition = async (
    record: SetupSessionRecord,
    to: SetupStatus,
    at: string,
    secrets?: readonly string[],
    detail?: string,
  ): Promise<void> => {
    const from = record.status;
    transitionRecord(record, to, at);
    await store.writeSession(record, secrets);
    await store.appendJournal(
      record.sessionId,
      {
        at,
        event: "STATE_TRANSITION",
        from,
        to,
        ...(detail === undefined ? {} : { detail }),
      },
      secrets,
    );
  };

  /**
   * Resolves the caller-supplied credential into (credential, redaction secrets),
   * or records a CREDENTIAL_REENTRY_REQUIRED blocker and returns undefined so the
   * caller can stop the operation and surface the snapshot.
   */
  const requireCredentialOrReenter = async (
    record: SetupSessionRecord,
    credential: CloudflareCredential | undefined,
    message: string,
  ): Promise<{ credential: CloudflareCredential; secrets: readonly string[] } | undefined> => {
    if (credential !== undefined) {
      validateCredential(credential);
      return { credential, secrets: credentialSecrets(credential) };
    }
    await requireCredentialReentry(store, record, timestamp(), message);
    return undefined;
  };

  /** Serializes mutation sessions via the on-disk lock; maps contention to an ACTIVE_SESSION blocker. */
  const acquireMutationLock = async (
    sessionId: string,
    status: "APPLYING" | "ROLLING_BACK",
    cause?: unknown,
  ): Promise<void> => {
    try {
      await store.acquireLock({ schemaVersion: "1", sessionId, status, pid, acquiredAt: timestamp() });
    } catch (error) {
      if ((error as Error).message === "Another setup mutation session is active") {
        throw new SetupError(
          { code: "ACTIVE_SESSION", message: "Another Setup Apply or Rollback session is active" },
          cause === undefined ? undefined : { cause },
        );
      }
      throw error;
    }
  };

  /** Releases the session lock if still held; never throws during cleanup. */
  const releaseLockSafely = async (sessionId: string): Promise<void> => {
    await store.releaseLock(sessionId).catch(() => undefined);
  };

  return {
    snapshot: ({ sessionId } = {}) => getSnapshot(sessionId),

    async preflight({ sessionId, idempotencyKey, zoneName, manifest: draft, credential }) {
      await initialize();
      validateBoundedId("sessionId", sessionId);
      validateBoundedId("idempotencyKey", idempotencyKey);
      if (await store.readSession(sessionId) !== undefined) {
        throw new Error(`Setup session already exists: ${sessionId}`);
      }
      validateZoneName(zoneName);
      validateManifestDraft(draft, zoneName);
      validateCredential(credential);
      await options.cloudflare.verifyCredential({ credential });
      const at = timestamp();
      const manifest: SetupManifest = {
        ...draft,
        schemaVersion: SETUP_MANIFEST_SCHEMA_VERSION,
        generatedAt: at,
      };
      const secrets = credentialSecrets(credential);
      await store.writeManifest(sessionId, manifest, secrets);
      await store.createJournal(sessionId, idempotencyKey, secrets);
      const record: SetupSessionRecord = {
        sessionId,
        idempotencyKey,
        target: { zoneName },
        status: "PREFLIGHT",
        requiresCredential: false,
        createdAt: at,
        updatedAt: at,
      };
      await store.writeSession(record, secrets);
      await store.appendJournal(
        sessionId,
        { at, event: "SESSION_CREATED", from: "IDLE", to: "PREFLIGHT" },
        secrets,
      );
      credentialCache.set(sessionId, credential);
      return (await getSnapshot(sessionId))!;
    },

    async plan({ sessionId }) {
      await initialize();
      const record = await requireSession(store, sessionId);
      const manifest = await requireManifest(store, sessionId);
      if (record.status !== "PREFLIGHT") {
        throw new Error(`Setup session must be in PREFLIGHT to plan (got ${record.status})`);
      }
      const credential = credentialCache.get(sessionId);
      if (credential === undefined) {
        const at = timestamp();
        record.blocker = {
          code: "CREDENTIAL_REENTRY_REQUIRED",
          message: "Cloudflare credential must be entered again before planning can continue",
        };
        await writeTransition(record, "NEEDS_CREDENTIAL_REENTRY", at, undefined, "In-memory credential cache was unavailable");
        throw new SetupError(record.blocker);
      }
      validateCredential(credential);
      const secrets = credentialSecrets(credential);
      await options.cloudflare.verifyCredential({ credential });
      const accounts = await collectPages((page) =>
        options.cloudflare.listAccounts({ credential, page, perPage: 50 }),
      );
      const located = await locateZone(options.cloudflare, credential, accounts, record.target.zoneName);
      if (located === undefined) {
        await persistBlocker(store, record, {
          code: "ZONE_NOT_FOUND",
          message: `Cloudflare zone ${record.target.zoneName} was not found. Onboard the domain before Apply.`,
        }, timestamp(), secrets);
        throw new SetupError(record.blocker!);
      }
      const { account, zone } = located;
      if (zone.status !== "active") {
        const blocker: SetupBlocker = {
          code: zone.status === "pending" ? "ZONE_PENDING" : "ZONE_NOT_ACTIVE",
          message: `Cloudflare zone ${zone.name} is ${zone.status}; Apply is stopped until it is active.`,
          nameservers: zone.nameservers,
        };
        await persistBlocker(store, record, blocker, timestamp(), secrets);
        throw new SetupError(blocker);
      }
      const tunnels = await listTunnels(options.cloudflare, credential, account.id, manifest.tunnelName);
      const dnsRecords = await listDnsRecords(options.cloudflare, credential, zone.id, manifest.desiredHostname);
      const ownedResourceIds = await locallyOwnedResourceIds(store);
      const tunnelsWithOwnership = tunnels.map((tunnel) => ({
        ...tunnel,
        ownedByToolSpan: tunnel.ownedByToolSpan === true || ownedResourceIds.tunnel.has(tunnel.id),
      }));
      const dnsWithOwnership = dnsRecords.map((record) => ({
        ...record,
        ownedByToolSpan: record.ownedByToolSpan === true || ownedResourceIds.dns.has(record.id),
      }));
      const serviceStatus = await options.cloudflared.inspect();
      if (options.cloudflared.automationMode === "manual" && !serviceStatus.serviceInstalled) {
        const blocker: SetupBlocker = {
          code: "MANUAL_OR_UAC_REQUIRED",
          message: "Scoped Apply is unavailable until a manual or UAC-approved cloudflared service is ready; use Guided manual setup.",
        };
        await persistBlocker(store, record, blocker, timestamp(), secrets);
        throw new SetupError(blocker);
      }
      const configuredPublicOrigin = options.readPublicMcpOrigin === undefined
        ? undefined
        : await options.readPublicMcpOrigin();
      const plannedAt = timestamp();
      let plan: SetupPlan;
      try {
        plan = await buildPlan({
          adapter: options.cloudflare,
          credential,
          manifest,
          account,
          zone,
          tunnels: tunnelsWithOwnership,
          dnsRecords: dnsWithOwnership,
          serviceStatus,
          configuredPublicOrigin,
          plannedAt,
          sessionId,
        });
      } catch (error) {
        if (error instanceof SetupError) {
          await persistBlocker(store, record, error.blocker, plannedAt, secrets);
        }
        throw error;
      }
      transitionRecord(record, "PLANNED", plannedAt);
      record.plan = plan;
      record.blocker = undefined;
      await store.writeSession(record, secrets);
      await store.appendJournal(sessionId, {
        at: plannedAt,
        event: "PLAN_CREATED",
        from: "PREFLIGHT",
        to: "PLANNED",
        detail: `${plan.actions.length} non-secret actions planned`,
      }, secrets);
      const waitingAt = timestamp();
      await writeTransition(record, "WAITING_FOR_CONFIRMATION", waitingAt, secrets);
      credentialCache.delete(sessionId);
      return (await getSnapshot(sessionId))!;
    },

    async apply(input) {
      if (input.confirmation !== "APPLY") {
        throw new SetupError({
          code: "CONFIRMATION_REQUIRED",
          message: "Apply requires the exact confirmation APPLY",
        });
      }
      await initialize();
      const record = await requireSession(store, input.sessionId);
      const resolved = await requireCredentialOrReenter(record, input.credential, "Apply requires a fresh Cloudflare credential");
      if (resolved === undefined) return snapshotOrThrow(input.sessionId);
      const { credential, secrets } = resolved;
      const manifest = await requireManifest(store, input.sessionId);
      // A re-entered session that had already planned may proceed straight back to Apply.
      if (
        record.status === "NEEDS_CREDENTIAL_REENTRY" &&
        record.plan !== undefined &&
        (await store.readReceipt(input.sessionId)) === undefined
      ) {
        transitionRecord(record, "WAITING_FOR_CONFIRMATION", timestamp());
        record.blocker = undefined;
        await store.writeSession(record, secrets);
      }
      if (record.status !== "WAITING_FOR_CONFIRMATION" || record.plan === undefined) {
        throw new Error(`Setup session must be waiting for confirmation (got ${record.status})`);
      }
      const stale = await recoverVerifiedStaleLock(store, processInspector, timestamp());
      if (stale?.sessionId === input.sessionId) {
        throw new SetupError({
          code: "RECONCILIATION_REQUIRED",
          message: "The interrupted Apply must be reconciled before it can continue",
        });
      }
      await acquireMutationLock(input.sessionId, "APPLYING");
      credentialCache.set(input.sessionId, credential);
      const startedAt = timestamp();
      const receipt: SetupReceipt = {
        schemaVersion: SETUP_RECEIPT_SCHEMA_VERSION,
        sessionId: input.sessionId,
        idempotencyKey: record.idempotencyKey,
        startedAt,
        resources: [],
        verification: [],
        rollback: { status: "not_started", resources: [] },
        duplicateCreates: 0,
      };
      let lockHeld = true;
      try {
        record.blocker = undefined;
        await writeTransition(record, "APPLYING", startedAt, secrets);
        await options.cloudflare.verifyCredential({ credential });
        const plan = record.plan;
        const ctx: ApplyContext = {
          store,
          cloudflare: options.cloudflare,
          cloudflared: options.cloudflared,
          sessionId: input.sessionId,
          record,
          manifest,
          plan,
          credential,
          secrets,
          receipt,
          writePublicMcpOrigin: options.writePublicMcpOrigin,
          readPublicMcpOrigin: options.readPublicMcpOrigin,
          at: timestamp,
        };

        applyAccountAndZoneMarkers(ctx);
        if (options.cloudflared.automationMode === "manual") {
          const serviceStatus = await options.cloudflared.inspect();
          if (!serviceStatus.serviceInstalled) {
            throw new SetupError({
              code: "MANUAL_OR_UAC_REQUIRED",
              message: "Scoped Apply is blocked until a manual or UAC-approved cloudflared service is available",
            });
          }
        }
        const { tunnel, ownedBySession: tunnelOwnedBySession } = await applyTunnel(ctx);
        const { previousTunnelConfig } = await applyTunnelConfig(ctx, tunnel, tunnelOwnedBySession);
        const { dns, previousDnsRecord } = await applyDns(ctx, tunnel);
        const { serviceId, serviceFingerprint, ownedBySession: serviceOwnedBySession } = await applyCloudflared(ctx, tunnel);
        const verifyingAt = timestamp();
        await writeTransition(record, "VERIFYING", verifyingAt, secrets);
        const { tunnelHealth, serviceHealth } = await verifyAppliedResources(ctx, tunnel, serviceId);
        if (!tunnelHealth.healthy || !serviceHealth.healthy) {
          throw new Error("Setup verification failed");
        }
        await applyToolspanConfig(ctx);
        const completedAt = timestamp();
        receipt.completedAt = completedAt;
        await store.writeReceipt(receipt, secrets);
        await writeTransition(record, "COMPLETE", completedAt, secrets);
        await store.releaseLock(input.sessionId);
        lockHeld = false;
        return snapshotOrThrow(input.sessionId);
      } catch (error) {
        const failedAt = timestamp();
        const safeMessage = redactText(error instanceof Error ? error.message : "Setup Apply failed", secrets);
        const errorCode = (error as { code?: unknown }).code;
        const publicError = error instanceof SetupError
          ? new SetupError({ ...error.blocker, message: safeMessage })
          : new SetupError({
              code: errorCode === "MANUAL_OR_UAC_REQUIRED"
                ? "MANUAL_OR_UAC_REQUIRED"
                : errorCode === "FINGERPRINT_MISMATCH"
                  ? "FINGERPRINT_MISMATCH"
                : "APPLY_FAILED",
              message: safeMessage,
            });
        receipt.completedAt = failedAt;
        await store.writeReceipt(receipt, secrets);
        const failedFrom = record.status as SetupStatus;
        if (failedFrom === "APPLYING" || failedFrom === "VERIFYING") {
          transitionRecord(record, "NEEDS_RECONCILIATION", failedAt);
          record.requiresCredential = true;
          record.blocker = {
            code: publicError.code,
            message: publicError.message,
          };
          await store.writeSession(record, secrets);
          await store.appendJournal(input.sessionId, {
            at: failedAt,
            event: "APPLY_FAILED",
            from: failedFrom,
            to: "NEEDS_RECONCILIATION",
            detail: record.blocker.message,
          }, secrets);
        }
        throw publicError;
      } finally {
        credentialCache.delete(input.sessionId);
        if (lockHeld) {
          await releaseLockSafely(input.sessionId);
        }
      }
    },

    async rollback(input) {
      if (input.confirmation !== "ROLLBACK") {
        throw new SetupError({
          code: "CONFIRMATION_REQUIRED",
          message: "Rollback requires the exact confirmation ROLLBACK",
        });
      }
      await initialize();
      const record = await requireSession(store, input.sessionId);
      if (record.status === "ROLLED_BACK") return snapshotOrThrow(input.sessionId);
      const resolved = await requireCredentialOrReenter(record, input.credential, "Rollback requires a fresh Cloudflare credential");
      if (resolved === undefined) return snapshotOrThrow(input.sessionId);
      const { credential, secrets } = resolved;
      const receipt = await store.readReceipt(input.sessionId);
      const manifest = await requireManifest(store, input.sessionId);
      if (receipt === undefined || record.plan === undefined) {
        throw new Error("Rollback requires an Apply receipt and plan");
      }
      if (!["COMPLETE", "NEEDS_RECONCILIATION", "NEEDS_CREDENTIAL_REENTRY", "ROLLBACK_PARTIAL"].includes(record.status)) {
        throw new Error(`Setup session cannot rollback from ${record.status}`);
      }
      // A verified-dead owner no longer blocks this independent rollback.
      await recoverVerifiedStaleLock(store, processInspector, timestamp());
      await acquireMutationLock(input.sessionId, "ROLLING_BACK");
      credentialCache.set(input.sessionId, credential);
      let lockHeld = true;
      try {
        await options.cloudflare.verifyCredential({ credential });
        const rollingAt = timestamp();
        record.blocker = undefined;
        await writeTransition(record, "ROLLING_BACK", rollingAt, secrets);
        const journal = await store.readJournal(input.sessionId);
        if (journal === undefined) throw new Error("Setup journal is unavailable");
        validateReceiptJournalBinding(receipt, journal, record.plan, input.sessionId);
        const rollbackResults = [...receipt.rollback.resources];
        const rollbackByKey = new Map(
          rollbackResults.map((result) => [rollbackResourceKey(result.kind, result.resourceId), result]),
        );
        const ctx: RollbackResourceContext = {
          store,
          cloudflare: options.cloudflare,
          cloudflared: options.cloudflared,
          sessionId: input.sessionId,
          manifest,
          credential,
          secrets,
          writePublicMcpOrigin: options.writePublicMcpOrigin,
          readPublicMcpOrigin: options.readPublicMcpOrigin,
          accountId: record.plan.account.id,
          zoneId: record.plan.zone.id,
          journal,
          at: timestamp,
        };
        // Undo in reverse apply order so dependent resources are removed first.
        for (const resource of [...receipt.resources].reverse()) {
          if (resource.classification === "untouched" || resource.classification === "reused") {
            continue;
          }
          const previousResult = rollbackByKey.get(rollbackResourceKey(resource.kind, resource.resourceId));
          if (previousResult !== undefined && previousResult.outcome !== "failed") continue;
          let result: SetupRollbackResource | undefined;
          try {
            result = await rollbackResource(ctx, resource);
          } catch (error) {
            result = {
              kind: resource.kind,
              resourceId: resource.resourceId,
              outcome: "failed",
              reason: redactText(error instanceof Error ? error.message : "Rollback action failed", secrets),
            };
          }
          if (result === undefined) continue;
          rollbackByKey.set(rollbackResourceKey(result.kind, result.resourceId), result);
          const persistedResults = [...rollbackByKey.values()];
          // Persist incremental progress so a crash mid-rollback can be resumed.
          receipt.rollback = { status: "partial", resources: persistedResults };
          await store.writeReceipt(receipt, secrets);
          await store.appendJournal(input.sessionId, {
            at: timestamp(),
            event: "ROLLBACK_ACTION",
            detail: `${result.kind}:${result.resourceId}:${result.outcome}:${result.reason}`,
          }, secrets);
        }
        const finalRollbackResults = [...rollbackByKey.values()];
        const partial = finalRollbackResults.some((result) => result.outcome === "failed");
        receipt.rollback = { status: partial ? "partial" : "full", resources: finalRollbackResults };
        receipt.completedAt = timestamp();
        await store.writeReceipt(receipt, secrets);
        const terminal = partial ? "ROLLBACK_PARTIAL" : "ROLLED_BACK";
        record.blocker = partial
          ? { code: "ROLLBACK_PARTIAL", message: "Rollback left resources that require manual reconciliation" }
          : undefined;
        await writeTransition(record, terminal, receipt.completedAt, secrets, partial
          ? "One or more fingerprint/ownership checks failed"
          : "All owned changes were reverted");
        await store.releaseLock(input.sessionId);
        lockHeld = false;
        return snapshotOrThrow(input.sessionId);
      } finally {
        credentialCache.delete(input.sessionId);
        if (lockHeld) await releaseLockSafely(input.sessionId);
      }
    },

    async reconcile(input) {
      await initialize();
      const record = await requireSession(store, input.sessionId);
      if (
        input.credential === undefined
        && (record.status === "COMPLETE" || record.status === "ROLLED_BACK")
      ) {
        return snapshotOrThrow(input.sessionId);
      }
      // SetupStore currently persists only APPLYING/ROLLING_BACK lock markers. Reconcile
      // uses the APPLYING marker for compatibility, but shares the exact same lock file.
      await recoverVerifiedStaleLock(store, processInspector, timestamp());
      await acquireMutationLock(input.sessionId, "APPLYING");
      let lockHeld = true;
      try {
        if (input.credential === undefined) {
          await requireCredentialReentry(store, record, timestamp(), "Reconciliation requires a fresh Cloudflare credential");
          return snapshotOrThrow(input.sessionId);
        }
        const credential = input.credential;
        validateCredential(credential);
        const secrets = credentialSecrets(credential);
        credentialCache.set(input.sessionId, credential);
        try {
        await options.cloudflare.verifyCredential({ credential });
        const receipt = await store.readReceipt(input.sessionId);
        if (record.status === "NEEDS_CREDENTIAL_REENTRY" && receipt === undefined) {
          // The interrupted session had not started mutating anything: restore its pre-lock state.
          const restoredStatus = record.plan === undefined ? "PREFLIGHT" : "WAITING_FOR_CONFIRMATION";
          transitionRecord(record, restoredStatus, timestamp());
          record.requiresCredential = false;
          record.blocker = undefined;
          await store.writeSession(record, secrets);
          if (restoredStatus === "PREFLIGHT") credentialCache.set(input.sessionId, credential);
          return snapshotOrThrow(input.sessionId);
        }
        if (record.status === "COMPLETE" || record.status === "ROLLED_BACK") {
          return snapshotOrThrow(input.sessionId);
        }
        if (receipt === undefined || record.plan === undefined) {
          await requireCredentialReentry(store, record, timestamp(), "No Apply journal is available to reconcile");
          return snapshotOrThrow(input.sessionId);
        }
        const journal = await store.readJournal(input.sessionId);
        if (journal === undefined) {
          await persistReconciliationRequired(
            store,
            record,
            timestamp(),
            "Setup journal is unavailable; remote resources were not inspected",
            secrets,
          );
          return snapshotOrThrow(input.sessionId);
        }
        try {
          validateReceiptJournalBinding(receipt, journal, record.plan, input.sessionId);
        } catch (error) {
          await persistReconciliationRequired(
            store,
            record,
            timestamp(),
            error instanceof Error ? error.message : "Setup receipt binding is invalid",
            secrets,
          );
          return snapshotOrThrow(input.sessionId);
        }
        if (record.status === "NEEDS_CREDENTIAL_REENTRY") {
          transitionRecord(record, "NEEDS_RECONCILIATION", timestamp());
        }
        const manifest = await requireManifest(store, input.sessionId);
        const { tunnel, dns, service, resourcesMatch } = await inspectRemoteResources({
          store,
          cloudflare: options.cloudflare,
          cloudflared: options.cloudflared,
          sessionId: input.sessionId,
          credential,
          plan: record.plan,
          receipt,
        });
        if (resourcesMatch && tunnel !== undefined && dns !== undefined) {
          const tunnelHealth = await options.cloudflare.verifyTunnelHealth({
            credential,
            accountId: record.plan.account.id,
            tunnelId: tunnel.id,
          });
          const serviceHealth = await options.cloudflared.verify({ serviceId: service.serviceId! });
          receipt.verification = [
            { check: "tunnel_health", passed: tunnelHealth.healthy, checkedAt: tunnelHealth.checkedAt },
            { check: "cloudflared", passed: serviceHealth.healthy, checkedAt: serviceHealth.checkedAt },
          ];
          if (tunnelHealth.healthy && serviceHealth.healthy) {
            const desiredOrigin = new URL(manifest.publicMcpUrl).origin;
            const configReceipt = receipt.resources.find((resource) => resource.kind === "toolspan_config");
            if (options.readPublicMcpOrigin !== undefined) {
              const currentOrigin = await options.readPublicMcpOrigin();
              if (currentOrigin !== desiredOrigin) {
                if (configReceipt !== undefined) {
                  await persistReconciliationRequired(
                    store,
                    record,
                    timestamp(),
                    "Core publicBaseUrl changed after Apply; no local config write was attempted",
                    secrets,
                  );
                  return snapshotOrThrow(input.sessionId);
                }
                await applyToolspanConfig({
                  store,
                  cloudflare: options.cloudflare,
                  cloudflared: options.cloudflared,
                  sessionId: input.sessionId,
                  record,
                  manifest,
                  plan: record.plan,
                  credential,
                  secrets,
                  receipt,
                  writePublicMcpOrigin: options.writePublicMcpOrigin,
                  readPublicMcpOrigin: options.readPublicMcpOrigin,
                  at: timestamp,
                });
                await store.writeReceipt(receipt, secrets);
              }
            } else if (configReceipt === undefined) {
              await applyToolspanConfig({
                store,
                cloudflare: options.cloudflare,
                cloudflared: options.cloudflared,
                sessionId: input.sessionId,
                record,
                manifest,
                plan: record.plan,
                credential,
                secrets,
                receipt,
                writePublicMcpOrigin: options.writePublicMcpOrigin,
                at: timestamp,
              });
              await store.writeReceipt(receipt, secrets);
            }
            const from = record.status;
            if (from !== "VERIFYING") transitionRecord(record, "VERIFYING", timestamp());
            transitionRecord(record, "COMPLETE", timestamp());
            record.requiresCredential = false;
            record.blocker = undefined;
            receipt.completedAt = timestamp();
            await store.writeReceipt(receipt, secrets);
            await store.writeSession(record, secrets);
            await store.appendJournal(input.sessionId, {
              at: receipt.completedAt,
              event: "RECONCILED",
              from,
              to: "COMPLETE",
              detail: "Remote resources match the non-secret journal",
            }, secrets);
            return snapshotOrThrow(input.sessionId);
          }
        }
        const from = record.status;
        if (from === "APPLYING" || from === "VERIFYING") {
          transitionRecord(record, "NEEDS_RECONCILIATION", timestamp());
        }
        record.requiresCredential = true;
        record.blocker = { code: "RECONCILIATION_REQUIRED", message: "Remote resources do not match the Apply journal; no writes were attempted" };
        await store.writeSession(record, secrets);
        await store.appendJournal(input.sessionId, {
          at: timestamp(),
          event: "RECONCILED",
          from,
          to: "NEEDS_RECONCILIATION",
          detail: record.blocker.message,
        }, secrets);
        return snapshotOrThrow(input.sessionId);
        } finally {
          if ((await store.readSession(input.sessionId))?.status !== "PREFLIGHT") {
            credentialCache.delete(input.sessionId);
          }
        }
      } finally {
        if (lockHeld) {
          await releaseLockSafely(input.sessionId);
          lockHeld = false;
        }
      }
    },

    async discard({ sessionId }) {
      await initialize();
      const record = await store.readSession(sessionId);
      if (record === undefined) return;
      if (record.status === "APPLYING" || record.status === "VERIFYING" || record.status === "ROLLING_BACK") {
        throw new Error("Cannot discard an active setup mutation session");
      }
      credentialCache.delete(sessionId);
      if (record.status === "PREFLIGHT" || record.status === "NEEDS_RECONCILIATION") {
        await requireCredentialReentry(
          store,
          record,
          timestamp(),
          "The in-memory Cloudflare credential was explicitly discarded",
        );
      }
    },
  };
}

// =============================================================================
// Apply pipeline: one function per resource, in apply order
// =============================================================================

interface ApplyContext {
  store: SetupStore;
  cloudflare: CloudflareAdapter;
  cloudflared: CloudflaredAdapter;
  sessionId: string;
  record: SetupSessionRecord;
  manifest: SetupManifest;
  plan: SetupPlan;
  credential: CloudflareCredential;
  secrets: readonly string[];
  receipt: SetupReceipt;
  writePublicMcpOrigin: (origin: string) => Promise<void>;
  readPublicMcpOrigin?: () => Promise<string>;
  /** Returns a fresh timestamp (keeps journal timestamps distinct per write). */
  at: () => string;
}

/** Marks the account and zone as untouched prerequisites in the receipt. */
function applyAccountAndZoneMarkers(ctx: ApplyContext): void {
  for (const kind of ["account", "zone"] as const) {
    const action = requireAction(ctx.plan, kind);
    ctx.receipt.resources.push(toReceiptResource(action, action.resourceId!, false, action.desiredFingerprint));
  }
}

/** Creates or reuses the Cloudflare tunnel, recording its receipt entry. */
async function applyTunnel(ctx: ApplyContext): Promise<{ tunnel: CloudflareTunnel; ownedBySession: boolean }> {
  const { store, cloudflare, sessionId, record, manifest, credential, plan, secrets } = ctx;
  const action = requireAction(plan, "tunnel");
  let tunnel: CloudflareTunnel;
  if (action.classification === "created") {
    tunnel = await cloudflare.createTunnel({
      credential,
      accountId: plan.account.id,
      name: manifest.tunnelName,
      idempotencyKey: record.idempotencyKey,
    });
  } else {
    const tunnels = await listTunnels(cloudflare, credential, plan.account.id, manifest.tunnelName);
    tunnel = tunnels.find((candidate) => candidate.id === action.resourceId) ??
      failReconciliation("The planned tunnel is no longer present");
    if (action.beforeFingerprint === undefined || tunnelFingerprint(tunnel) !== action.beforeFingerprint) {
      failReconciliation("Tunnel identity changed after Dry Run");
    }
  }
  const ownedBySession = action.classification === "created";
  const tunnelReceipt = toReceiptResource(action, tunnel.id, ownedBySession, tunnelFingerprint(tunnel));
  ctx.receipt.resources.push(tunnelReceipt);
  await appendApplyResource(store, sessionId, tunnelReceipt, ctx.at(), secrets);
  return { tunnel, ownedBySession };
}

/** Applies the tunnel ingress config: creates, updates, or confirms it is already correct. */
async function applyTunnelConfig(
  ctx: ApplyContext,
  tunnel: CloudflareTunnel,
  tunnelOwnedBySession: boolean,
): Promise<{ previousTunnelConfig?: CloudflareTunnelConfig }> {
  const { store, cloudflare, sessionId, manifest, credential, plan, secrets } = ctx;
  const action = requireAction(plan, "tunnel_config");
  const config = desiredTunnelConfig(manifest);
  const previousTunnelConfig = action.classification === "updated" || action.classification === "untouched"
    ? await cloudflare.readTunnelConfig({ credential, accountId: plan.account.id, tunnelId: tunnel.id })
    : undefined;
  if (
    action.classification === "updated" &&
    (previousTunnelConfig === undefined || fingerprint(previousTunnelConfig) !== action.beforeFingerprint)
  ) {
    failReconciliation("Tunnel configuration changed after Dry Run");
  }
  if (
    action.classification === "untouched" &&
    (previousTunnelConfig === undefined || fingerprint(previousTunnelConfig) !== action.desiredFingerprint)
  ) {
    failReconciliation("Tunnel configuration no longer matches the Dry Run");
  }
  if (action.classification === "created" || action.classification === "updated") {
    await cloudflare.updateTunnelConfig({
      credential,
      accountId: plan.account.id,
      tunnelId: tunnel.id,
      config,
      ...(action.beforeFingerprint === undefined
        ? {}
        : { expectedFingerprint: action.beforeFingerprint }),
    });
  }
  const configReceipt = toReceiptResource(action, tunnel.id, tunnelOwnedBySession, fingerprint(config));
  ctx.receipt.resources.push(configReceipt);
  await appendApplyResource(
    store,
    sessionId,
    configReceipt,
    ctx.at(),
    secrets,
    previousTunnelConfig === undefined
      ? undefined
      : {
          kind: "tunnel_config",
          resourceId: tunnel.id,
          accountId: plan.account.id,
          previousTunnelConfig,
          appliedFingerprint: configReceipt.afterFingerprint!,
        },
  );
  return { previousTunnelConfig };
}

/** Creates, updates, or reuses the CNAME DNS record; returns it with any pre-change value. */
async function applyDns(
  ctx: ApplyContext,
  tunnel: CloudflareTunnel,
): Promise<{ dns: CloudflareDnsRecord; previousDnsRecord?: CloudflareDnsRecord }> {
  const { store, cloudflare, sessionId, record, manifest, credential, plan, secrets } = ctx;
  const action = requireAction(plan, "dns");
  const desiredDns: Omit<CloudflareDnsRecord, "id" | "zoneId"> = {
    type: "CNAME",
    name: manifest.desiredHostname,
    content: `${tunnel.id}.cfargotunnel.com`,
    proxied: true,
    ttl: 1,
    ownedByToolSpan: true,
    ownershipKey: record.idempotencyKey,
  };
  let dns: CloudflareDnsRecord;
  let previousDnsRecord: CloudflareDnsRecord | undefined;
  if (action.classification === "created") {
    dns = await cloudflare.createDnsRecord({
      credential,
      zoneId: plan.zone.id,
      record: desiredDns,
      idempotencyKey: record.idempotencyKey,
    });
  } else if (action.classification === "updated") {
    if (action.resourceId === undefined || action.beforeFingerprint === undefined) {
      throw new Error("Updated DNS plan is missing its precondition");
    }
    const currentRecords = await listDnsRecords(cloudflare, credential, plan.zone.id, manifest.desiredHostname);
    previousDnsRecord = currentRecords.find((candidate) => candidate.id === action.resourceId);
    if (
      previousDnsRecord === undefined ||
      fingerprint(stripDnsIdentity(previousDnsRecord)) !== action.beforeFingerprint
    ) {
      failReconciliation("DNS record changed after Dry Run");
    }
    dns = await cloudflare.updateOwnedDnsRecord({
      credential,
      zoneId: plan.zone.id,
      recordId: action.resourceId,
      record: desiredDns,
      expectedFingerprint: action.beforeFingerprint,
    });
  } else {
    const records = await listDnsRecords(cloudflare, credential, plan.zone.id, manifest.desiredHostname);
    dns = records.find((candidate) => candidate.id === action.resourceId) ??
      failReconciliation("The planned DNS record is no longer present");
    if (fingerprint(stripDnsIdentity(dns)) !== action.desiredFingerprint) {
      failReconciliation("DNS record no longer matches the Dry Run");
    }
  }
  const dnsReceipt = toReceiptResource(
    action,
    dns.id,
    action.classification === "created",
    fingerprint(stripDnsIdentity(dns)),
  );
  ctx.receipt.resources.push(dnsReceipt);
  await appendApplyResource(
    store,
    sessionId,
    dnsReceipt,
    ctx.at(),
    secrets,
    previousDnsRecord === undefined
      ? undefined
      : {
          kind: "dns",
          resourceId: dns.id,
          zoneId: plan.zone.id,
          previousDnsRecord,
          appliedFingerprint: dnsReceipt.afterFingerprint!,
        },
  );
  return { dns, previousDnsRecord };
}

/** Installs (or confirms) the local cloudflared service, recording its receipt entry. */
async function applyCloudflared(
  ctx: ApplyContext,
  tunnel: CloudflareTunnel,
): Promise<{ serviceId: string; serviceFingerprint?: string; ownedBySession: boolean }> {
  const { store, cloudflare, cloudflared, sessionId, manifest, credential, plan, secrets } = ctx;
  const action = requireAction(plan, "cloudflared");
  let serviceId = action.resourceId;
  let serviceFingerprint = action.beforeFingerprint;
  let serviceOwned = false;
  if (action.classification === "created") {
    const runtimeCredential = await cloudflare.getTunnelRuntimeCredential({
      credential,
      accountId: plan.account.id,
      tunnelId: tunnel.id,
    });
    let installed: Awaited<ReturnType<CloudflaredAdapter["install"]>>;
    try {
      installed = await cloudflared.install({
        sessionId,
        tunnelId: tunnel.id,
        hostname: manifest.desiredHostname,
        localUrl: manifest.localUrl,
        runtimeCredential: runtimeCredential.token,
      });
    } catch (error) {
      throw new Error(
        redactText(
          error instanceof Error ? error.message : "cloudflared installation failed",
          [...secrets, runtimeCredential.token],
        ),
        { cause: error },
      );
    }
    serviceId = installed.serviceId;
    serviceFingerprint = installed.serviceFingerprint;
    serviceOwned = installed.ownedBySession && installed.ownerSessionId === sessionId;
  }
  if (serviceId === undefined) {
    throw new Error("cloudflared service ID is unavailable");
  }
  if (action.classification === "reused") {
    const currentService = await cloudflared.inspect();
    if (
      !currentService.serviceInstalled ||
      currentService.serviceId !== serviceId ||
      currentService.serviceFingerprint !== serviceFingerprint
    ) {
      failReconciliation("cloudflared service changed after Dry Run");
    }
  }
  const cloudflaredReceipt = toReceiptResource(
    action,
    serviceId,
    action.classification === "created" && serviceOwned,
    serviceFingerprint ?? action.desiredFingerprint,
  );
  ctx.receipt.resources.push(cloudflaredReceipt);
  await appendApplyResource(store, sessionId, cloudflaredReceipt, ctx.at(), secrets);
  return { serviceId, serviceFingerprint, ownedBySession: serviceOwned };
}

/** Marks the desktop-side publicBaseUrl update in the receipt (applied atomically by the host). */
async function applyToolspanConfig(ctx: ApplyContext): Promise<void> {
  const action = requireAction(ctx.plan, "toolspan_config");
  const desiredOrigin = new URL(ctx.manifest.publicMcpUrl).origin;
  const currentOrigin = ctx.readPublicMcpOrigin === undefined
    ? undefined
    : await ctx.readPublicMcpOrigin();
  if (
    action.beforeFingerprint !== undefined
    && (currentOrigin === undefined || fingerprint(currentOrigin) !== action.beforeFingerprint)
  ) {
    failReconciliation("Core publicBaseUrl changed after Dry Run");
  }
  if (currentOrigin !== desiredOrigin) {
    await ctx.writePublicMcpOrigin(desiredOrigin);
  }
  const configReceipt = toReceiptResource(
    action,
    "publicBaseUrl",
    action.classification === "updated",
    fingerprint(desiredOrigin),
  );
  ctx.receipt.resources.push(configReceipt);
  if (action.classification === "updated" && currentOrigin !== undefined) {
    await appendApplyResource(
      ctx.store,
      ctx.sessionId,
      configReceipt,
      ctx.at(),
      ctx.secrets,
      {
        kind: "toolspan_config",
        resourceId: "publicBaseUrl",
        previousPublicBaseUrl: currentOrigin,
        appliedFingerprint: configReceipt.afterFingerprint!,
      },
    );
  }
}

/** Checks tunnel + service health and records verification evidence in the receipt. */
async function verifyAppliedResources(
  ctx: ApplyContext,
  tunnel: CloudflareTunnel,
  serviceId: string,
): Promise<{
  tunnelHealth: Awaited<ReturnType<CloudflareAdapter["verifyTunnelHealth"]>>;
  serviceHealth: Awaited<ReturnType<CloudflaredAdapter["verify"]>>;
}> {
  const tunnelHealth = await ctx.cloudflare.verifyTunnelHealth({
    credential: ctx.credential,
    accountId: ctx.plan.account.id,
    tunnelId: tunnel.id,
  });
  ctx.receipt.verification.push({
    check: "tunnel_health",
    passed: tunnelHealth.healthy,
    checkedAt: tunnelHealth.checkedAt,
  });
  const serviceHealth = await ctx.cloudflared.verify({ serviceId });
  ctx.receipt.verification.push({
    check: "cloudflared",
    passed: serviceHealth.healthy,
    checkedAt: serviceHealth.checkedAt,
  });
  return { tunnelHealth, serviceHealth };
}

// =============================================================================
// Rollback pipeline
// =============================================================================

interface RollbackResourceContext {
  store: SetupStore;
  cloudflare: CloudflareAdapter;
  cloudflared: CloudflaredAdapter;
  sessionId: string;
  manifest: SetupManifest;
  credential: CloudflareCredential;
  secrets: readonly string[];
  writePublicMcpOrigin: (origin: string) => Promise<void>;
  readPublicMcpOrigin?: () => Promise<string>;
  accountId: string;
  zoneId: string;
  journal: SetupJournal;
  at: () => string;
}

/**
 * Reverts a single resource this session created or updated.
 * Throws when the remote state no longer matches the journal (fingerprint/ownership drift);
 * returns undefined for combinations that need no action (e.g. a config created together
 * with its tunnel, which disappears when the tunnel is deleted).
 */
async function rollbackResource(
  ctx: RollbackResourceContext,
  resource: SetupReceiptResource,
): Promise<SetupRollbackResource | undefined> {
  const {
    store,
    cloudflare,
    cloudflared,
    sessionId,
    manifest,
    credential,
    accountId,
    zoneId,
    journal,
    writePublicMcpOrigin,
    readPublicMcpOrigin,
  } = ctx;

  if (resource.kind === "toolspan_config" && resource.classification === "updated") {
    if (resource.afterFingerprint === undefined || readPublicMcpOrigin === undefined) {
      throw new Error("Core publicBaseUrl rollback proof is unavailable");
    }
    const current = await readPublicMcpOrigin();
    if (fingerprint(current) !== resource.afterFingerprint) {
      throw new Error("Core publicBaseUrl changed after Apply");
    }
    const previous = findRollbackData(journal, "toolspan_config", resource.resourceId)?.previousPublicBaseUrl;
    if (previous === undefined) throw new Error("Core publicBaseUrl restore data is unavailable");
    await writePublicMcpOrigin(previous);
    return { kind: resource.kind, resourceId: resource.resourceId, outcome: "restored", reason: "Core publicBaseUrl restored" };
  }

  if (resource.kind === "cloudflared" && resource.classification === "created") {
    if (!resource.ownedBySession || resource.afterFingerprint === undefined) {
      throw new Error("cloudflared ownership proof is unavailable");
    }
    const status = await cloudflared.inspect();
    if (
      status.serviceId !== resource.resourceId ||
      status.serviceFingerprint !== resource.afterFingerprint ||
      status.ownedBySession !== true ||
      status.ownerSessionId !== sessionId
    ) {
      throw new Error("cloudflared service fingerprint or ownership changed");
    }
    const removed = await cloudflared.uninstallOwnedService({
      sessionId,
      serviceId: resource.resourceId,
      expectedFingerprint: resource.afterFingerprint,
    });
    if (!removed.removed) throw new Error("cloudflared service was not removed");
    return { kind: resource.kind, resourceId: resource.resourceId, outcome: "removed", reason: "Session-owned service removed" };
  }

  if (resource.kind === "dns") {
    const records = await listDnsRecords(cloudflare, credential, zoneId, manifest.desiredHostname);
    const current = records.find((candidate) => candidate.id === resource.resourceId);
    if (current === undefined || fingerprint(stripDnsIdentity(current)) !== resource.afterFingerprint) {
      throw new Error("DNS fingerprint changed after Apply");
    }
    if (resource.classification === "created") {
      if (!resource.ownedBySession || cloudflare.deleteOwnedDnsRecord === undefined) {
        throw new Error("Session-owned DNS delete capability is unavailable");
      }
      const deleted = await cloudflare.deleteOwnedDnsRecord({
        credential,
        zoneId,
        recordId: resource.resourceId,
        expectedFingerprint: resource.afterFingerprint!,
      });
      if (!deleted.deleted) throw new Error("DNS record was not deleted");
      return { kind: resource.kind, resourceId: resource.resourceId, outcome: "removed", reason: "Session-created DNS removed" };
    }
    if (resource.classification === "updated") {
      const previous = findRollbackData(journal, "dns", resource.resourceId)?.previousDnsRecord;
      if (previous === undefined) throw new Error("DNS restore data is unavailable");
      await cloudflare.updateOwnedDnsRecord({
        credential,
        zoneId,
        recordId: resource.resourceId,
        record: stripDnsIdentity(previous),
        expectedFingerprint: resource.afterFingerprint!,
      });
      return { kind: resource.kind, resourceId: resource.resourceId, outcome: "restored", reason: "Owned DNS restored to its non-secret pre-change value" };
    }
    return undefined;
  }

  if (resource.kind === "tunnel_config" && resource.classification === "updated") {
    const previous = findRollbackData(journal, "tunnel_config", resource.resourceId)?.previousTunnelConfig;
    if (previous === undefined || resource.afterFingerprint === undefined) {
      throw new Error("Tunnel config restore data is unavailable");
    }
    const current = await cloudflare.readTunnelConfig({ credential, accountId, tunnelId: resource.resourceId });
    if (current === undefined || fingerprint(current) !== resource.afterFingerprint) {
      throw new Error("Tunnel config fingerprint changed after Apply");
    }
    await cloudflare.updateTunnelConfig({
      credential,
      accountId,
      tunnelId: resource.resourceId,
      config: previous,
      expectedFingerprint: resource.afterFingerprint,
    });
    return { kind: resource.kind, resourceId: resource.resourceId, outcome: "restored", reason: "Owned tunnel config restored" };
  }

  if (resource.kind === "tunnel" && resource.classification === "created") {
    if (!resource.ownedBySession || resource.afterFingerprint === undefined || cloudflare.deleteOwnedTunnel === undefined) {
      throw new Error("Session-owned tunnel delete capability is unavailable");
    }
    const tunnels = await listTunnels(cloudflare, credential, accountId, manifest.tunnelName);
    const current = tunnels.find((candidate) => candidate.id === resource.resourceId);
    if (current === undefined || tunnelFingerprint(current) !== resource.afterFingerprint) {
      throw new Error("Tunnel fingerprint changed after Apply");
    }
    const deleted = await cloudflare.deleteOwnedTunnel({
      credential,
      accountId,
      tunnelId: resource.resourceId,
      expectedFingerprint: resource.afterFingerprint,
    });
    if (!deleted.deleted) throw new Error("Tunnel was not deleted");
    return { kind: resource.kind, resourceId: resource.resourceId, outcome: "removed", reason: "Session-created tunnel removed" };
  }

  return undefined;
}

/** Finds the most recent rollback journal data recorded for a given resource. */
function findRollbackData(
  journal: SetupJournal,
  kind: "dns" | "tunnel_config" | "toolspan_config",
  resourceId: string,
): SetupJournalEntry["rollbackData"] {
  return [...journal.entries].reverse().find(
    (entry) => entry.rollbackData?.kind === kind && entry.rollbackData.resourceId === resourceId,
  )?.rollbackData;
}

function rollbackResourceKey(kind: SetupResourceKind, resourceId: string): string {
  return `${kind}:${resourceId}`;
}

/** Refuses recovery when the persisted receipt and journal no longer describe the same Apply. */
function validateReceiptJournalBinding(
  receipt: SetupReceipt,
  journal: SetupJournal,
  plan: SetupPlan,
  sessionId: string,
): void {
  if (
    receipt.sessionId !== sessionId
    || journal.sessionId !== sessionId
    || receipt.idempotencyKey !== journal.idempotencyKey
  ) {
    throw new SetupError({
      code: "RECONCILIATION_REQUIRED",
      message: "Setup receipt and journal are not bound to the requested session",
    });
  }
  const applied = journal.entries
    .filter((entry) => entry.event === "APPLY_ACTION" && entry.resource !== undefined)
    .map((entry) => entry.resource!);
  for (const resource of receipt.resources) {
    const action = plan.actions.find((candidate) => candidate.kind === resource.kind);
    if (
      action === undefined
      || resource.name !== action.name
      || resource.desiredFingerprint !== action.desiredFingerprint
      || (action.resourceId !== undefined && resource.resourceId !== action.resourceId)
    ) {
      throw new SetupError({
        code: "RECONCILIATION_REQUIRED",
        message: `Setup receipt resource binding is invalid for ${resource.kind}`,
      });
    }
    if (["tunnel", "tunnel_config", "dns", "cloudflared"].includes(resource.kind)) {
      const journalResource = applied.find((candidate) =>
        candidate.kind === resource.kind
        && candidate.resourceId === resource.resourceId
        && candidate.afterFingerprint === resource.afterFingerprint
        && candidate.ownedBySession === resource.ownedBySession,
      );
      if (journalResource === undefined) {
        throw new SetupError({
          code: "RECONCILIATION_REQUIRED",
          message: `Setup journal binding is missing for ${resource.kind}`,
        });
      }
    }
  }
}

// =============================================================================
// Reconciliation helpers
// =============================================================================

interface ReconcileContext {
  store: SetupStore;
  cloudflare: CloudflareAdapter;
  cloudflared: CloudflaredAdapter;
  sessionId: string;
  credential: CloudflareCredential;
  plan: SetupPlan;
  receipt: SetupReceipt;
}

/** Reads the current remote resources and decides whether they still match the Apply journal. */
async function inspectRemoteResources(ctx: ReconcileContext): Promise<{
  tunnel: CloudflareTunnel | undefined;
  dns: CloudflareDnsRecord | undefined;
  service: Awaited<ReturnType<CloudflaredAdapter["inspect"]>>;
  resourcesMatch: boolean;
}> {
  const { store, cloudflare, cloudflared, sessionId, credential, plan, receipt } = ctx;
  const manifest = await requireManifest(store, sessionId);
  const tunnelReceipt = receipt.resources.find((resource) => resource.kind === "tunnel");
  const dnsReceipt = receipt.resources.find((resource) => resource.kind === "dns");
  const serviceReceipt = receipt.resources.find((resource) => resource.kind === "cloudflared");
  const tunnelConfigReceipt = receipt.resources.find((resource) => resource.kind === "tunnel_config");
  if (
    tunnelReceipt === undefined
    || dnsReceipt === undefined
    || serviceReceipt === undefined
    || tunnelConfigReceipt === undefined
  ) {
    return { tunnel: undefined, dns: undefined, service: await cloudflared.inspect(), resourcesMatch: false };
  }
  const tunnels = await listTunnels(cloudflare, credential, plan.account.id, requireAction(plan, "tunnel").name);
  const tunnel = tunnels.find((candidate) => candidate.id === tunnelReceipt?.resourceId);
  const desiredConfig = desiredTunnelConfig(manifest);
  const currentConfig = tunnel === undefined
    ? undefined
    : await cloudflare.readTunnelConfig({ credential, accountId: plan.account.id, tunnelId: tunnel.id });
  const records = await listDnsRecords(cloudflare, credential, plan.zone.id, requireAction(plan, "dns").name);
  const dns = records.find((candidate) => candidate.id === dnsReceipt?.resourceId);
  const service = await cloudflared.inspect();
  const resourcesMatch =
    tunnel !== undefined &&
    tunnel.accountId === plan.account.id &&
    tunnel.name === requireAction(plan, "tunnel").name &&
    tunnelFingerprint(tunnel) === tunnelReceipt.afterFingerprint &&
    (!tunnelReceipt.ownedBySession || tunnel.ownedByToolSpan !== false) &&
    currentConfig !== undefined &&
    fingerprint(currentConfig) === fingerprint(desiredConfig) &&
    fingerprint(currentConfig) === tunnelConfigReceipt.afterFingerprint &&
    tunnelConfigReceipt.resourceId === tunnel.id &&
    dns !== undefined &&
    dns.zoneId === plan.zone.id &&
    dns.name === requireAction(plan, "dns").name &&
    fingerprint(stripDnsIdentity(dns)) === dnsReceipt.afterFingerprint &&
    (!dnsReceipt.ownedBySession || dns.ownedByToolSpan !== false) &&
    dns.content === `${tunnel.id}.cfargotunnel.com` &&
    dns.proxied === true &&
    service.serviceInstalled &&
    service.serviceId === serviceReceipt.resourceId &&
    service.serviceFingerprint === serviceReceipt.afterFingerprint &&
    (!serviceReceipt.ownedBySession || (service.ownedBySession === true && service.ownerSessionId === sessionId));
  return { tunnel, dns, service, resourcesMatch };
}

// =============================================================================
// Planning helpers
// =============================================================================

async function buildPlan(input: {
  adapter: CloudflareAdapter;
  credential: CloudflareCredential;
  manifest: SetupManifest;
  account: CloudflareAccount;
  zone: CloudflareZone;
  tunnels: CloudflareTunnel[];
  dnsRecords: CloudflareDnsRecord[];
  serviceStatus: Awaited<ReturnType<CloudflaredAdapter["inspect"]>>;
  configuredPublicOrigin?: string;
  plannedAt: string;
  sessionId: string;
}): Promise<SetupPlan> {
  if (input.tunnels.length > 1) {
    throw new SetupError({ code: "TUNNEL_CONFLICT", message: "Multiple same-name Cloudflare tunnels were found" });
  }
  const tunnel = input.tunnels[0];
  if (tunnel !== undefined && tunnel.ownedByToolSpan !== true) {
    throw new SetupError({ code: "TUNNEL_CONFLICT", message: "A same-name tunnel exists without ToolSpan ownership proof" });
  }
  if (input.dnsRecords.length > 1) {
    throw new SetupError({ code: "DNS_CONFLICT", message: "Multiple DNS records exist for the desired hostname" });
  }
  const desiredConfig = desiredTunnelConfig(input.manifest);
  const desiredConfigFingerprint = fingerprint(desiredConfig);
  const desiredPublicOrigin = new URL(input.manifest.publicMcpUrl).origin;
  const currentConfig = tunnel === undefined
    ? undefined
    : await input.adapter.readTunnelConfig({
        credential: input.credential,
        accountId: input.account.id,
        tunnelId: tunnel.id,
      });
  const currentConfigFingerprint = currentConfig === undefined ? undefined : fingerprint(currentConfig);
  const tunnelTarget = tunnel === undefined ? "planned-tunnel.cfargotunnel.com" : `${tunnel.id}.cfargotunnel.com`;
  const dns = input.dnsRecords[0];
  if (
    dns !== undefined &&
    dns.ownedByToolSpan !== true &&
    !(dns.type === "CNAME" && dns.content === tunnelTarget && dns.proxied)
  ) {
    throw new SetupError({ code: "DNS_CONFLICT", message: "The desired hostname is occupied by a DNS record ToolSpan does not own" });
  }
  const desiredDns = {
    type: "CNAME" as const,
    name: input.manifest.desiredHostname,
    content: tunnelTarget,
    proxied: true,
    ttl: 1,
  };
  const dnsMatches = dns !== undefined && fingerprint(stripDnsIdentity(dns)) === fingerprint(desiredDns);
  const actions: SetupPlanAction[] = [
    {
      kind: "account",
      classification: "untouched",
      resourceId: input.account.id,
      name: input.account.name,
      desiredFingerprint: fingerprint(input.account),
      reason: "Selected Cloudflare account",
    },
    {
      kind: "zone",
      classification: "untouched",
      resourceId: input.zone.id,
      name: input.zone.name,
      desiredFingerprint: fingerprint(input.zone),
      reason: "Active Cloudflare zone is a prerequisite and is never modified",
    },
    {
      kind: "tunnel",
      classification: tunnel === undefined ? "created" : "reused",
      ...(tunnel === undefined ? {} : { resourceId: tunnel.id, beforeFingerprint: tunnelFingerprint(tunnel) }),
      name: input.manifest.tunnelName,
      desiredFingerprint: fingerprint({ name: input.manifest.tunnelName }),
      reason: tunnel === undefined ? "No same-name tunnel exists" : "Existing ToolSpan-owned tunnel is reusable",
    },
    {
      kind: "tunnel_config",
      classification:
        tunnel === undefined ? "created" : currentConfigFingerprint === desiredConfigFingerprint ? "untouched" : "updated",
      ...(tunnel === undefined ? {} : { resourceId: tunnel.id }),
      ...(currentConfigFingerprint === undefined ? {} : { beforeFingerprint: currentConfigFingerprint }),
      name: input.manifest.tunnelName,
      desiredFingerprint: desiredConfigFingerprint,
      reason: currentConfigFingerprint === desiredConfigFingerprint ? "Ingress already matches" : "Ingress must route the desired hostname and include a catch-all",
    },
    {
      kind: "dns",
      classification: dns === undefined ? "created" : dnsMatches ? "reused" : "updated",
      ...(dns === undefined ? {} : { resourceId: dns.id, beforeFingerprint: fingerprint(stripDnsIdentity(dns)) }),
      name: input.manifest.desiredHostname,
      desiredFingerprint: fingerprint(desiredDns),
      reason: dns === undefined ? "Desired hostname is available" : dnsMatches ? "DNS already routes to the selected tunnel" : "Owned DNS needs an update",
    },
    {
      kind: "cloudflared",
      classification: input.serviceStatus.serviceInstalled ? "reused" : "created",
      ...(input.serviceStatus.serviceId === undefined ? {} : { resourceId: input.serviceStatus.serviceId }),
      ...(input.serviceStatus.serviceFingerprint === undefined ? {} : { beforeFingerprint: input.serviceStatus.serviceFingerprint }),
      name: "cloudflared service",
      desiredFingerprint: fingerprint({ tunnel: input.manifest.tunnelName, hostname: input.manifest.desiredHostname }),
      reason: input.serviceStatus.serviceInstalled ? "Existing service will be left in place" : "A managed cloudflared service is required",
    },
    {
      kind: "toolspan_config",
      classification: input.configuredPublicOrigin === undefined || input.configuredPublicOrigin === desiredPublicOrigin
        ? "untouched"
        : "updated",
      resourceId: "publicBaseUrl",
      ...(input.configuredPublicOrigin === undefined
        ? {}
        : { beforeFingerprint: fingerprint(input.configuredPublicOrigin) }),
      name: "publicBaseUrl",
      desiredFingerprint: fingerprint(desiredPublicOrigin),
      reason: "The Desktop host applies publicBaseUrl atomically after the domain transaction",
    },
  ];
  return {
    schemaVersion: "1",
    sessionId: input.sessionId,
    account: { id: input.account.id, name: input.account.name },
    zone: {
      id: input.zone.id,
      name: input.zone.name,
      status: input.zone.status,
      nameservers: input.zone.nameservers,
    },
    actions,
    warnings: input.serviceStatus.serviceInstalled && input.serviceStatus.ownedBySession !== true
      ? ["An external cloudflared service exists and will not be changed automatically"]
      : [],
    confirmationRequired: true,
    plannedAt: input.plannedAt,
  };
}

async function locateZone(
  adapter: CloudflareAdapter,
  credential: CloudflareCredential,
  accounts: CloudflareAccount[],
  zoneName: string,
): Promise<{ account: CloudflareAccount; zone: CloudflareZone } | undefined> {
  const matches: { account: CloudflareAccount; zone: CloudflareZone }[] = [];
  for (const account of accounts) {
    const zones = await collectPages((page) =>
      adapter.listZones({ credential, accountId: account.id, name: zoneName, page, perPage: 50 }),
    );
    for (const zone of zones) matches.push({ account, zone });
  }
  if (matches.length > 1) throw new Error(`Zone ${zoneName} is ambiguous across Cloudflare accounts`);
  return matches[0];
}

/** Paginates through a Cloudflare listing until the last page is reached. */
async function collectPages<T>(
  load: (page: number) => Promise<{ items: T[]; page: number; totalPages: number }>,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const result = await load(page);
    items.push(...result.items);
    if (result.page >= result.totalPages) return items;
    if (page >= 100) throw new Error("Cloudflare pagination exceeded the safety limit");
  }
}

function listTunnels(
  cloudflare: CloudflareAdapter,
  credential: CloudflareCredential,
  accountId: string,
  name: string,
): Promise<CloudflareTunnel[]> {
  return collectPages((page) => cloudflare.listTunnels({ credential, accountId, name, page, perPage: 50 }));
}

function listDnsRecords(
  cloudflare: CloudflareAdapter,
  credential: CloudflareCredential,
  zoneId: string,
  name: string,
): Promise<CloudflareDnsRecord[]> {
  return collectPages((page) => cloudflare.listDnsRecords({ credential, zoneId, name, page, perPage: 50 }));
}

function desiredTunnelConfig(manifest: SetupManifest): CloudflareTunnelConfig {
  return {
    ingress: [
      { hostname: manifest.desiredHostname, service: manifest.localUrl },
      { service: "http_status:404" },
    ],
  };
}

function stripDnsIdentity(record: CloudflareDnsRecord): Omit<CloudflareDnsRecord, "id" | "zoneId" | "ownedByToolSpan" | "ownershipKey"> {
  return {
    type: record.type,
    name: record.name,
    content: record.content,
    proxied: record.proxied,
    ttl: record.ttl,
  };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function tunnelFingerprint(tunnel: CloudflareTunnel): string {
  return fingerprint({ id: tunnel.id, accountId: tunnel.accountId, name: tunnel.name });
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

// =============================================================================
// Manifest & input validation
// =============================================================================

function validateManifestDraft(draft: SetupManifestDraft, zoneName: string): void {
  assertToolSpanVersion(draft.toolSpanVersion);
  assertLength(draft.instanceName, "instanceName", 1, 80);
  if (draft.expectedToolCount !== 27) throw new Error("Setup requires the exact 27 Tool Contract");
  assertLoopbackUrl(draft.localUrl, "Setup localUrl must be an HTTP loopback URL");
  assertPublicUrlsHttps(draft.publicMcpUrl, draft.oauthDiscoveryUrl);
  assertPublicUrlsUseDesiredHostname(draft.publicMcpUrl, draft.oauthDiscoveryUrl, draft.desiredHostname);
  assertHostnameUnderZone(draft.desiredHostname, zoneName);
  assertMcpEndpoint(draft.publicMcpUrl);
  assertOauthDiscoveryEndpoint(draft.oauthDiscoveryUrl);
  assertLength(draft.tunnelName, "tunnelName", 1, 100);
  if (!["existing", "other_registrar", "namesilo_no_referral"].includes(draft.domainChoice)) {
    throw new Error("Safe Manifest domainChoice is invalid");
  }
  assertOfficialDocs(draft.officialDocs);
}

function assertToolSpanVersion(version: string): void {
  if (!/^0\.7\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error("Safe Manifest toolSpanVersion must be a 0.7.x version");
  }
}

function assertLength(value: string, label: string, min: number, max: number): void {
  if (value.length < min || value.length > max) {
    throw new Error(`Safe Manifest ${label} must contain ${min}-${max} characters`);
  }
}

function assertLoopbackUrl(value: string, message: string): void {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(message);
  }
}

function assertPublicUrlsHttps(publicMcpUrl: string, oauthDiscoveryUrl: string): void {
  const publicMcp = new URL(publicMcpUrl);
  const oauth = new URL(oauthDiscoveryUrl);
  if (
    publicMcp.protocol !== "https:" ||
    oauth.protocol !== "https:" ||
    publicMcp.username !== "" ||
    publicMcp.password !== "" ||
    oauth.username !== "" ||
    oauth.password !== ""
  ) {
    throw new Error("Public MCP and OAuth discovery URLs must use HTTPS");
  }
}

function assertPublicUrlsUseDesiredHostname(publicMcpUrl: string, oauthDiscoveryUrl: string, desiredHostname: string): void {
  const publicMcp = new URL(publicMcpUrl);
  const oauth = new URL(oauthDiscoveryUrl);
  if (publicMcp.hostname !== desiredHostname || oauth.hostname !== desiredHostname) {
    throw new Error("Public URLs must use the desired hostname");
  }
}

function assertHostnameUnderZone(desiredHostname: string, zoneName: string): void {
  if (desiredHostname !== `mcp.${zoneName}` && !desiredHostname.endsWith(`.${zoneName}`)) {
    throw new Error("Desired hostname must belong to the selected zone");
  }
}

function assertMcpEndpoint(publicMcpUrl: string): void {
  const publicMcp = new URL(publicMcpUrl);
  if (publicMcp.pathname !== "/mcp" || publicMcp.search !== "" || publicMcp.hash !== "") {
    throw new Error("Public MCP URL must use the exact /mcp endpoint without query or fragment");
  }
}

function assertOauthDiscoveryEndpoint(oauthDiscoveryUrl: string): void {
  const oauth = new URL(oauthDiscoveryUrl);
  if (!oauth.pathname.startsWith("/.well-known/") || oauth.search !== "" || oauth.hash !== "") {
    throw new Error("OAuth discovery URL must use an HTTPS /.well-known/ endpoint");
  }
}

function assertOfficialDocs(docs: string[]): void {
  if (docs.length < 1 || docs.length > 32) {
    throw new Error("Safe Manifest requires 1-32 official docs URLs");
  }
  for (const doc of docs) {
    const url = new URL(doc);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      !["developers.cloudflare.com", "developers.openai.com"].includes(url.hostname)
    ) {
      throw new Error("Official docs URLs must use official Cloudflare or OpenAI HTTPS origins");
    }
  }
}

function validateZoneName(zoneName: string): void {
  if (zoneName.length > 253 || !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u.test(zoneName)) {
    throw new Error("zoneName must be a bounded DNS domain name");
  }
}

function validateBoundedId(label: "sessionId" | "idempotencyKey", value: string): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(value)) {
    throw new Error(`${label} must contain 8-128 URL-safe identifier characters`);
  }
}

// =============================================================================
// Session record & store helpers
// =============================================================================

function transitionRecord(record: SetupSessionRecord, to: SetupStatus, at: string): void {
  assertTransition(record.status, to);
  record.status = to;
  record.updatedAt = at;
  record.requiresCredential = to === "NEEDS_CREDENTIAL_REENTRY";
}

async function requireSession(store: SetupStore, sessionId: string): Promise<SetupSessionRecord> {
  const record = await store.readSession(sessionId);
  if (record === undefined) throw new Error(`Setup session not found: ${sessionId}`);
  return record;
}

async function requireManifest(store: SetupStore, sessionId: string): Promise<SetupManifest> {
  const manifest = await store.readManifest(sessionId);
  if (manifest === undefined) throw new Error(`Setup manifest not found: ${sessionId}`);
  return manifest;
}

async function persistBlocker(
  store: SetupStore,
  record: SetupSessionRecord,
  blocker: SetupBlocker,
  at: string,
  secrets: readonly string[],
): Promise<void> {
  record.blocker = blocker;
  record.updatedAt = at;
  await store.writeSession(record, secrets);
}

async function persistReconciliationRequired(
  store: SetupStore,
  record: SetupSessionRecord,
  at: string,
  message: string,
  secrets: readonly string[],
): Promise<void> {
  const from = record.status;
  if (from !== "NEEDS_RECONCILIATION") transitionRecord(record, "NEEDS_RECONCILIATION", at);
  record.requiresCredential = true;
  record.blocker = { code: "RECONCILIATION_REQUIRED", message };
  await store.writeSession(record, secrets);
  await store.appendJournal(record.sessionId, {
    at,
    event: "RECONCILED",
    from,
    to: "NEEDS_RECONCILIATION",
    detail: message,
  }, secrets);
}

async function locallyOwnedResourceIds(
  store: SetupStore,
): Promise<{ tunnel: Set<string>; dns: Set<string> }> {
  const owned = { tunnel: new Set<string>(), dns: new Set<string>() };
  for (const receipt of await store.listReceipts()) {
    const removed = new Set(
      receipt.rollback.resources
        .filter((resource) => resource.outcome === "removed")
        .map((resource) => `${resource.kind}:${resource.resourceId}`),
    );
    for (const resource of receipt.resources) {
      if (
        resource.classification === "created" &&
        resource.ownedBySession &&
        (resource.kind === "tunnel" || resource.kind === "dns") &&
        !removed.has(`${resource.kind}:${resource.resourceId}`)
      ) {
        owned[resource.kind].add(resource.resourceId);
      }
    }
  }
  return owned;
}

async function requireCredentialReentry(
  store: SetupStore,
  record: SetupSessionRecord,
  at: string,
  message: string,
): Promise<void> {
  const from = record.status;
  if (from !== "NEEDS_CREDENTIAL_REENTRY") {
    transitionRecord(record, "NEEDS_CREDENTIAL_REENTRY", at);
  }
  record.requiresCredential = true;
  record.blocker = { code: "CREDENTIAL_REENTRY_REQUIRED", message };
  await store.writeSession(record);
  if (from !== "NEEDS_CREDENTIAL_REENTRY") {
    await store.appendJournal(record.sessionId, {
      at,
      event: "STATE_TRANSITION",
      from,
      to: "NEEDS_CREDENTIAL_REENTRY",
      detail: message,
    });
  }
}

function requireAction(plan: SetupPlan, kind: SetupPlanAction["kind"]): SetupPlanAction {
  const action = plan.actions.find((candidate) => candidate.kind === kind);
  if (action === undefined) throw new Error(`Setup plan is missing ${kind}`);
  return action;
}

function toReceiptResource(
  action: SetupPlanAction,
  resourceId: string,
  ownedBySession: boolean,
  afterFingerprint: string,
): SetupReceiptResource {
  return { ...action, resourceId, ownedBySession, afterFingerprint };
}

async function appendApplyResource(
  store: SetupStore,
  sessionId: string,
  resource: SetupReceiptResource,
  at: string,
  secrets: readonly string[],
  rollbackData?: NonNullable<SetupJournalEntry["rollbackData"]>,
): Promise<void> {
  await store.appendJournal(sessionId, {
    at,
    event: "APPLY_ACTION",
    resource,
    ...(rollbackData === undefined ? {} : { rollbackData }),
  }, secrets);
}

function failReconciliation(message: string): never {
  throw new SetupError({ code: "RECONCILIATION_REQUIRED", message });
}

async function recoverVerifiedStaleLock(
  store: SetupStore,
  inspector: ProcessInspector,
  at: string,
): Promise<SetupLock | undefined> {
  const stale = await store.removeVerifiedStaleLock(inspector);
  if (stale === undefined) return undefined;
  const record = await store.readSession(stale.sessionId);
  if (record !== undefined && (record.status === "APPLYING" || record.status === "ROLLING_BACK")) {
    const from = record.status;
    transitionRecord(record, "NEEDS_CREDENTIAL_REENTRY", at);
    record.blocker = {
      code: "CREDENTIAL_REENTRY_REQUIRED",
      message: "An interrupted setup mutation was recovered; re-enter a credential and reconcile",
    };
    await store.writeSession(record);
    await store.appendJournal(stale.sessionId, {
      at,
      event: "STALE_LOCK_RECOVERED",
      from,
      to: "NEEDS_CREDENTIAL_REENTRY",
      detail: `Verified stale PID ${stale.pid}`,
    });
  }
  return stale;
}
