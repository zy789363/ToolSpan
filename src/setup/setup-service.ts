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
  type SetupManifest,
  type SetupManifestDraft,
  type SetupPlan,
  type SetupPlanAction,
  type SetupReceipt,
  type SetupReceiptResource,
  type SetupSessionRecord,
  type SetupSnapshot,
  type SetupStatus,
} from "./types.js";

export interface SetupServiceOptions {
  directory: string;
  cloudflare: CloudflareAdapter;
  cloudflared: CloudflaredAdapter;
  now?: () => Date;
  pid?: number;
  processInspector?: ProcessInspector;
}

export interface SetupService {
  snapshot(input?: { sessionId?: string }): Promise<SetupSnapshot | undefined>;
  preflight(input: { sessionId: string; idempotencyKey: string; zoneName: string; manifest: SetupManifestDraft; credential: CloudflareCredential }): Promise<SetupSnapshot>;
  plan(input: { sessionId: string }): Promise<SetupSnapshot>;
  apply(input: { sessionId: string; confirmation: "APPLY"; credential?: CloudflareCredential }): Promise<SetupSnapshot>;
  rollback(input: { sessionId: string; confirmation: "ROLLBACK"; credential?: CloudflareCredential }): Promise<SetupSnapshot>;
  reconcile(input: { sessionId: string; credential?: CloudflareCredential }): Promise<SetupSnapshot>;
  discard(input: { sessionId: string }): Promise<void>;
}

export function createSetupService(options: SetupServiceOptions): SetupService {
  const store = new SetupStore(options.directory);
  const now = options.now ?? (() => new Date());
  const processInspector = options.processInspector ?? operatingSystemProcessInspector;
  const pid = options.pid ?? process.pid;
  const credentialCache = new Map<string, CloudflareCredential>();
  let initialization: Promise<void> | undefined;

  const initialize = async (): Promise<void> => {
    initialization ??= (async () => {
      const at = now().toISOString();
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
        const from = record.status;
        transitionRecord(record, "NEEDS_CREDENTIAL_REENTRY", at);
        record.blocker = {
          code: "CREDENTIAL_REENTRY_REQUIRED",
          message: "The host restarted and the in-memory Cloudflare credential is unavailable",
        };
        await store.writeSession(record);
        await store.appendJournal(record.sessionId, {
          at,
          event: "STATE_TRANSITION",
          from,
          to: "NEEDS_CREDENTIAL_REENTRY",
          detail: "Credential cache is intentionally process-local",
        });
      }
    })();
    await initialization;
  };

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
      const at = now().toISOString();
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
        const at = now().toISOString();
        transitionRecord(record, "NEEDS_CREDENTIAL_REENTRY", at);
        record.blocker = {
          code: "CREDENTIAL_REENTRY_REQUIRED",
          message: "Cloudflare credential must be entered again before planning can continue",
        };
        await store.writeSession(record);
        await store.appendJournal(sessionId, {
          at,
          event: "STATE_TRANSITION",
          from: "PREFLIGHT",
          to: "NEEDS_CREDENTIAL_REENTRY",
          detail: "In-memory credential cache was unavailable",
        });
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
        }, now().toISOString(), secrets);
        throw new SetupError(record.blocker!);
      }
      const { account, zone } = located;
      if (zone.status !== "active") {
        const blocker: SetupBlocker = {
          code: zone.status === "pending" ? "ZONE_PENDING" : "ZONE_NOT_ACTIVE",
          message: `Cloudflare zone ${zone.name} is ${zone.status}; Apply is stopped until it is active.`,
          nameservers: zone.nameservers,
        };
        await persistBlocker(store, record, blocker, now().toISOString(), secrets);
        throw new SetupError(blocker);
      }
      const tunnels = await collectPages((page) =>
        options.cloudflare.listTunnels({
          credential,
          accountId: account.id,
          name: manifest.tunnelName,
          page,
          perPage: 50,
        }),
      );
      const dnsRecords = await collectPages((page) =>
        options.cloudflare.listDnsRecords({
          credential,
          zoneId: zone.id,
          name: manifest.desiredHostname,
          page,
          perPage: 50,
        }),
      );
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
      const plannedAt = now().toISOString();
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
      const waitingAt = now().toISOString();
      transitionRecord(record, "WAITING_FOR_CONFIRMATION", waitingAt);
      await store.writeSession(record, secrets);
      await store.appendJournal(sessionId, {
        at: waitingAt,
        event: "STATE_TRANSITION",
        from: "PLANNED",
        to: "WAITING_FOR_CONFIRMATION",
      }, secrets);
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
      const pendingRecord = await requireSession(store, input.sessionId);
      if (input.credential === undefined) {
        await requireCredentialReentry(store, pendingRecord, now().toISOString(), "Apply requires a fresh Cloudflare credential");
        return (await getSnapshot(input.sessionId))!;
      }
      const credential = input.credential;
      validateCredential(credential);
      const secrets = credentialSecrets(credential);
      const record = pendingRecord;
      const manifest = await requireManifest(store, input.sessionId);
      if (
        record.status === "NEEDS_CREDENTIAL_REENTRY" &&
        record.plan !== undefined &&
        (await store.readReceipt(input.sessionId)) === undefined
      ) {
        transitionRecord(record, "WAITING_FOR_CONFIRMATION", now().toISOString());
        record.blocker = undefined;
        await store.writeSession(record, secrets);
      }
      if (record.status !== "WAITING_FOR_CONFIRMATION" || record.plan === undefined) {
        throw new Error(`Setup session must be waiting for confirmation (got ${record.status})`);
      }
      const stale = await recoverVerifiedStaleLock(store, processInspector, now().toISOString());
      if (stale?.sessionId === input.sessionId) {
        throw new SetupError({
          code: "RECONCILIATION_REQUIRED",
          message: "The interrupted Apply must be reconciled before it can continue",
        });
      }
      try {
        await store.acquireLock({
          schemaVersion: "1",
          sessionId: input.sessionId,
          status: "APPLYING",
          pid,
          acquiredAt: now().toISOString(),
        });
      } catch (error) {
        if ((error as Error).message === "Another setup mutation session is active") {
          throw new SetupError({
            code: "ACTIVE_SESSION",
            message: "Another Setup Apply or Rollback session is active",
          }, { cause: error });
        }
        throw error;
      }
      credentialCache.set(input.sessionId, credential);
      const startedAt = now().toISOString();
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
        transitionRecord(record, "APPLYING", startedAt);
        record.blocker = undefined;
        await store.writeSession(record, secrets);
        await store.appendJournal(input.sessionId, {
          at: startedAt,
          event: "STATE_TRANSITION",
          from: "WAITING_FOR_CONFIRMATION",
          to: "APPLYING",
        }, secrets);
        await options.cloudflare.verifyCredential({ credential });
        const plan = record.plan;
        const accountId = plan.account.id;
        const zoneId = plan.zone.id;

        for (const kind of ["account", "zone"] as const) {
          const action = requireAction(plan, kind);
          receipt.resources.push(toReceiptResource(action, action.resourceId!, false, action.desiredFingerprint));
        }

        const tunnelAction = requireAction(plan, "tunnel");
        let tunnel: CloudflareTunnel;
        if (tunnelAction.classification === "created") {
          tunnel = await options.cloudflare.createTunnel({
            credential,
            accountId,
            name: manifest.tunnelName,
            idempotencyKey: record.idempotencyKey,
          });
        } else {
          const tunnels = await collectPages((page) =>
            options.cloudflare.listTunnels({
              credential,
              accountId,
              name: manifest.tunnelName,
              page,
              perPage: 50,
            }),
          );
          tunnel = tunnels.find((candidate) => candidate.id === tunnelAction.resourceId) ??
            failReconciliation("The planned tunnel is no longer present");
          if (
            tunnelAction.beforeFingerprint === undefined ||
            tunnelFingerprint(tunnel) !== tunnelAction.beforeFingerprint
          ) {
            failReconciliation("Tunnel identity changed after Dry Run");
          }
        }
        const tunnelReceipt = toReceiptResource(
          tunnelAction,
          tunnel.id,
          tunnelAction.classification === "created",
          tunnelFingerprint(tunnel),
        );
        receipt.resources.push(tunnelReceipt);
        await appendApplyResource(store, input.sessionId, tunnelReceipt, now().toISOString(), secrets);

        const configAction = requireAction(plan, "tunnel_config");
        const config = desiredTunnelConfig(manifest);
        const previousTunnelConfig = configAction.classification === "updated" || configAction.classification === "untouched"
          ? await options.cloudflare.readTunnelConfig({ credential, accountId, tunnelId: tunnel.id })
          : undefined;
        if (
          configAction.classification === "updated" &&
          (previousTunnelConfig === undefined || fingerprint(previousTunnelConfig) !== configAction.beforeFingerprint)
        ) {
          failReconciliation("Tunnel configuration changed after Dry Run");
        }
        if (
          configAction.classification === "untouched" &&
          (previousTunnelConfig === undefined || fingerprint(previousTunnelConfig) !== configAction.desiredFingerprint)
        ) {
          failReconciliation("Tunnel configuration no longer matches the Dry Run");
        }
        if (configAction.classification === "created" || configAction.classification === "updated") {
          await options.cloudflare.updateTunnelConfig({
            credential,
            accountId,
            tunnelId: tunnel.id,
            config,
            ...(configAction.beforeFingerprint === undefined
              ? {}
              : { expectedFingerprint: configAction.beforeFingerprint }),
          });
        }
        const configReceipt = toReceiptResource(
          configAction,
          tunnel.id,
          tunnelAction.classification === "created",
          fingerprint(config),
        );
        receipt.resources.push(configReceipt);
        await appendApplyResource(
          store,
          input.sessionId,
          configReceipt,
          now().toISOString(),
          secrets,
          previousTunnelConfig === undefined
            ? undefined
            : {
                kind: "tunnel_config",
                resourceId: tunnel.id,
                accountId,
                previousTunnelConfig,
                appliedFingerprint: configReceipt.afterFingerprint!,
              },
        );

        const dnsAction = requireAction(plan, "dns");
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
        if (dnsAction.classification === "created") {
          dns = await options.cloudflare.createDnsRecord({
            credential,
            zoneId,
            record: desiredDns,
            idempotencyKey: record.idempotencyKey,
          });
        } else if (dnsAction.classification === "updated") {
          if (dnsAction.resourceId === undefined || dnsAction.beforeFingerprint === undefined) {
            throw new Error("Updated DNS plan is missing its precondition");
          }
          const currentRecords = await collectPages((page) =>
            options.cloudflare.listDnsRecords({
              credential,
              zoneId,
              name: manifest.desiredHostname,
              page,
              perPage: 50,
            }),
          );
          previousDnsRecord = currentRecords.find((candidate) => candidate.id === dnsAction.resourceId);
          if (
            previousDnsRecord === undefined ||
            fingerprint(stripDnsIdentity(previousDnsRecord)) !== dnsAction.beforeFingerprint
          ) {
            failReconciliation("DNS record changed after Dry Run");
          }
          dns = await options.cloudflare.updateOwnedDnsRecord({
            credential,
            zoneId,
            recordId: dnsAction.resourceId,
            record: desiredDns,
            expectedFingerprint: dnsAction.beforeFingerprint,
          });
        } else {
          const records = await collectPages((page) =>
            options.cloudflare.listDnsRecords({
              credential,
              zoneId,
              name: manifest.desiredHostname,
              page,
              perPage: 50,
            }),
          );
          dns = records.find((candidate) => candidate.id === dnsAction.resourceId) ??
            failReconciliation("The planned DNS record is no longer present");
          if (fingerprint(stripDnsIdentity(dns)) !== dnsAction.desiredFingerprint) {
            failReconciliation("DNS record no longer matches the Dry Run");
          }
        }
        const dnsReceipt = toReceiptResource(
          dnsAction,
          dns.id,
          dnsAction.classification === "created",
          fingerprint(stripDnsIdentity(dns)),
        );
        receipt.resources.push(dnsReceipt);
        await appendApplyResource(
          store,
          input.sessionId,
          dnsReceipt,
          now().toISOString(),
          secrets,
          previousDnsRecord === undefined
            ? undefined
            : {
                kind: "dns",
                resourceId: dns.id,
                zoneId,
                previousDnsRecord,
                appliedFingerprint: dnsReceipt.afterFingerprint!,
              },
        );

        const cloudflaredAction = requireAction(plan, "cloudflared");
        let serviceId = cloudflaredAction.resourceId;
        let serviceFingerprint = cloudflaredAction.beforeFingerprint;
        let serviceOwned = false;
        if (cloudflaredAction.classification === "created") {
          const runtimeCredential = await options.cloudflare.getTunnelRuntimeCredential({
            credential,
            accountId,
            tunnelId: tunnel.id,
          });
          let installed: Awaited<ReturnType<CloudflaredAdapter["install"]>>;
          try {
            installed = await options.cloudflared.install({
              sessionId: input.sessionId,
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
          serviceOwned = installed.ownedBySession && installed.ownerSessionId === input.sessionId;
        }
        if (serviceId === undefined) {
          throw new Error("cloudflared service ID is unavailable");
        }
        if (cloudflaredAction.classification === "reused") {
          const currentService = await options.cloudflared.inspect();
          if (
            !currentService.serviceInstalled ||
            currentService.serviceId !== serviceId ||
            currentService.serviceFingerprint !== serviceFingerprint
          ) {
            failReconciliation("cloudflared service changed after Dry Run");
          }
        }
        const cloudflaredReceipt = toReceiptResource(
          cloudflaredAction,
          serviceId,
          cloudflaredAction.classification === "created" && serviceOwned,
          serviceFingerprint ?? cloudflaredAction.desiredFingerprint,
        );
        receipt.resources.push(cloudflaredReceipt);
        await appendApplyResource(store, input.sessionId, cloudflaredReceipt, now().toISOString(), secrets);

        const configMarker = requireAction(plan, "toolspan_config");
        receipt.resources.push(toReceiptResource(configMarker, "publicBaseUrl", false, configMarker.desiredFingerprint));

        const verifyingAt = now().toISOString();
        transitionRecord(record, "VERIFYING", verifyingAt);
        await store.writeSession(record, secrets);
        await store.appendJournal(input.sessionId, {
          at: verifyingAt,
          event: "STATE_TRANSITION",
          from: "APPLYING",
          to: "VERIFYING",
        }, secrets);
        const tunnelHealth = await options.cloudflare.verifyTunnelHealth({
          credential,
          accountId,
          tunnelId: tunnel.id,
        });
        receipt.verification.push({
          check: "tunnel_health",
          passed: tunnelHealth.healthy,
          checkedAt: tunnelHealth.checkedAt,
        });
        const serviceHealth = await options.cloudflared.verify({ serviceId });
        receipt.verification.push({
          check: "cloudflared",
          passed: serviceHealth.healthy,
          checkedAt: serviceHealth.checkedAt,
        });
        if (!tunnelHealth.healthy || !serviceHealth.healthy) {
          throw new Error("Setup verification failed");
        }
        const completedAt = now().toISOString();
        receipt.completedAt = completedAt;
        await store.writeReceipt(receipt, secrets);
        transitionRecord(record, "COMPLETE", completedAt);
        record.requiresCredential = false;
        await store.writeSession(record, secrets);
        await store.appendJournal(input.sessionId, {
          at: completedAt,
          event: "STATE_TRANSITION",
          from: "VERIFYING",
          to: "COMPLETE",
        }, secrets);
        await store.releaseLock(input.sessionId);
        lockHeld = false;
        return (await getSnapshot(input.sessionId))!;
      } catch (error) {
        const failedAt = now().toISOString();
        const safeMessage = redactText(error instanceof Error ? error.message : "Setup Apply failed", secrets);
        const publicError = error instanceof SetupError
          ? new SetupError({ ...error.blocker, message: safeMessage })
          : new SetupError({
              code: (error as { code?: unknown }).code === "MANUAL_OR_UAC_REQUIRED"
                ? "MANUAL_OR_UAC_REQUIRED"
                : "APPLY_FAILED",
              message: safeMessage,
            });
        receipt.completedAt = failedAt;
        await store.writeReceipt(receipt, secrets);
        const failedFrom = record.status as SetupStatus;
        if (failedFrom === "APPLYING" || failedFrom === "VERIFYING") {
          const from = failedFrom;
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
            from,
            to: "NEEDS_RECONCILIATION",
            detail: record.blocker.message,
          }, secrets);
        }
        throw publicError;
      } finally {
        credentialCache.delete(input.sessionId);
        if (lockHeld) {
          await store.releaseLock(input.sessionId).catch(() => undefined);
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
      if (record.status === "ROLLED_BACK") return (await getSnapshot(input.sessionId))!;
      if (input.credential === undefined) {
        await requireCredentialReentry(store, record, now().toISOString(), "Rollback requires a fresh Cloudflare credential");
        return (await getSnapshot(input.sessionId))!;
      }
      const credential = input.credential;
      validateCredential(credential);
      const secrets = credentialSecrets(credential);
      const receipt = await store.readReceipt(input.sessionId);
      const manifest = await requireManifest(store, input.sessionId);
      if (receipt === undefined || record.plan === undefined) {
        throw new Error("Rollback requires an Apply receipt and plan");
      }
      if (!["COMPLETE", "NEEDS_RECONCILIATION", "NEEDS_CREDENTIAL_REENTRY", "ROLLBACK_PARTIAL"].includes(record.status)) {
        throw new Error(`Setup session cannot rollback from ${record.status}`);
      }
      const stale = await recoverVerifiedStaleLock(store, processInspector, now().toISOString());
      if (stale !== undefined && stale.sessionId !== input.sessionId) {
        // A verified-dead owner no longer blocks this independent rollback.
      }
      try {
        await store.acquireLock({
          schemaVersion: "1",
          sessionId: input.sessionId,
          status: "ROLLING_BACK",
          pid,
          acquiredAt: now().toISOString(),
        });
      } catch (error) {
        if ((error as Error).message === "Another setup mutation session is active") {
          throw new SetupError({ code: "ACTIVE_SESSION", message: "Another Setup Apply or Rollback session is active" });
        }
        throw error;
      }
      credentialCache.set(input.sessionId, credential);
      let lockHeld = true;
      try {
        await options.cloudflare.verifyCredential({ credential });
        const from = record.status;
        const rollingAt = now().toISOString();
        transitionRecord(record, "ROLLING_BACK", rollingAt);
        record.blocker = undefined;
        await store.writeSession(record, secrets);
        await store.appendJournal(input.sessionId, {
          at: rollingAt,
          event: "STATE_TRANSITION",
          from,
          to: "ROLLING_BACK",
        }, secrets);
        const journal = await store.readJournal(input.sessionId);
        if (journal === undefined) throw new Error("Setup journal is unavailable");
        const rollbackResults: SetupReceipt["rollback"]["resources"] = [];
        const accountId = record.plan.account.id;
        const zoneId = record.plan.zone.id;
        for (const resource of [...receipt.resources].reverse()) {
          if (resource.classification === "untouched" || resource.classification === "reused") {
            continue;
          }
          try {
            if (resource.kind === "cloudflared" && resource.classification === "created") {
              if (!resource.ownedBySession || resource.afterFingerprint === undefined) {
                throw new Error("cloudflared ownership proof is unavailable");
              }
              const status = await options.cloudflared.inspect();
              if (
                status.serviceId !== resource.resourceId ||
                status.serviceFingerprint !== resource.afterFingerprint ||
                status.ownedBySession !== true ||
                status.ownerSessionId !== input.sessionId
              ) {
                throw new Error("cloudflared service fingerprint or ownership changed");
              }
              const removed = await options.cloudflared.uninstallOwnedService({
                sessionId: input.sessionId,
                serviceId: resource.resourceId,
                expectedFingerprint: resource.afterFingerprint,
              });
              if (!removed.removed) throw new Error("cloudflared service was not removed");
              rollbackResults.push({ kind: resource.kind, resourceId: resource.resourceId, outcome: "removed", reason: "Session-owned service removed" });
            } else if (resource.kind === "dns") {
              const records = await collectPages((page) =>
                options.cloudflare.listDnsRecords({ credential, zoneId, name: manifest.desiredHostname, page, perPage: 50 }),
              );
              const current = records.find((candidate) => candidate.id === resource.resourceId);
              if (current === undefined || fingerprint(stripDnsIdentity(current)) !== resource.afterFingerprint) {
                throw new Error("DNS fingerprint changed after Apply");
              }
              if (resource.classification === "created") {
                if (!resource.ownedBySession || options.cloudflare.deleteOwnedDnsRecord === undefined) {
                  throw new Error("Session-owned DNS delete capability is unavailable");
                }
                const deleted = await options.cloudflare.deleteOwnedDnsRecord({
                  credential,
                  zoneId,
                  recordId: resource.resourceId,
                  expectedFingerprint: resource.afterFingerprint!,
                });
                if (!deleted.deleted) throw new Error("DNS record was not deleted");
                rollbackResults.push({ kind: resource.kind, resourceId: resource.resourceId, outcome: "removed", reason: "Session-created DNS removed" });
              } else if (resource.classification === "updated") {
                const rollbackData = [...journal.entries].reverse().find(
                  (entry) => entry.rollbackData?.kind === "dns" && entry.rollbackData.resourceId === resource.resourceId,
                )?.rollbackData;
                const previous = rollbackData?.previousDnsRecord;
                if (previous === undefined) throw new Error("DNS restore data is unavailable");
                await options.cloudflare.updateOwnedDnsRecord({
                  credential,
                  zoneId,
                  recordId: resource.resourceId,
                  record: stripDnsIdentity(previous),
                  expectedFingerprint: resource.afterFingerprint!,
                });
                rollbackResults.push({ kind: resource.kind, resourceId: resource.resourceId, outcome: "restored", reason: "Owned DNS restored to its non-secret pre-change value" });
              }
            } else if (resource.kind === "tunnel_config" && resource.classification === "updated") {
              const rollbackData = [...journal.entries].reverse().find(
                (entry) => entry.rollbackData?.kind === "tunnel_config" && entry.rollbackData.resourceId === resource.resourceId,
              )?.rollbackData;
              const previous = rollbackData?.previousTunnelConfig;
              if (previous === undefined || resource.afterFingerprint === undefined) {
                throw new Error("Tunnel config restore data is unavailable");
              }
              const current = await options.cloudflare.readTunnelConfig({ credential, accountId, tunnelId: resource.resourceId });
              if (current === undefined || fingerprint(current) !== resource.afterFingerprint) {
                throw new Error("Tunnel config fingerprint changed after Apply");
              }
              await options.cloudflare.updateTunnelConfig({
                credential,
                accountId,
                tunnelId: resource.resourceId,
                config: previous,
                expectedFingerprint: resource.afterFingerprint,
              });
              rollbackResults.push({ kind: resource.kind, resourceId: resource.resourceId, outcome: "restored", reason: "Owned tunnel config restored" });
            } else if (resource.kind === "tunnel" && resource.classification === "created") {
              if (!resource.ownedBySession || resource.afterFingerprint === undefined || options.cloudflare.deleteOwnedTunnel === undefined) {
                throw new Error("Session-owned tunnel delete capability is unavailable");
              }
              const tunnels = await collectPages((page) =>
                options.cloudflare.listTunnels({ credential, accountId, name: manifest.tunnelName, page, perPage: 50 }),
              );
              const current = tunnels.find((candidate) => candidate.id === resource.resourceId);
              if (current === undefined || tunnelFingerprint(current) !== resource.afterFingerprint) {
                throw new Error("Tunnel fingerprint changed after Apply");
              }
              const deleted = await options.cloudflare.deleteOwnedTunnel({
                credential,
                accountId,
                tunnelId: resource.resourceId,
                expectedFingerprint: resource.afterFingerprint,
              });
              if (!deleted.deleted) throw new Error("Tunnel was not deleted");
              rollbackResults.push({ kind: resource.kind, resourceId: resource.resourceId, outcome: "removed", reason: "Session-created tunnel removed" });
            }
          } catch (error) {
            rollbackResults.push({
              kind: resource.kind,
              resourceId: resource.resourceId,
              outcome: "failed",
              reason: redactText(error instanceof Error ? error.message : "Rollback action failed", secrets),
            });
          }
          const latest = rollbackResults.at(-1);
          if (latest !== undefined && latest.resourceId === resource.resourceId) {
            receipt.rollback = { status: "partial", resources: [...rollbackResults] };
            await store.writeReceipt(receipt, secrets);
            await store.appendJournal(input.sessionId, {
              at: now().toISOString(),
              event: "ROLLBACK_ACTION",
              detail: `${latest.kind}:${latest.resourceId}:${latest.outcome}:${latest.reason}`,
            }, secrets);
          }
        }
        const partial = rollbackResults.some((result) => result.outcome === "failed");
        receipt.rollback = { status: partial ? "partial" : "full", resources: rollbackResults };
        receipt.completedAt = now().toISOString();
        await store.writeReceipt(receipt, secrets);
        const terminal = partial ? "ROLLBACK_PARTIAL" : "ROLLED_BACK";
        transitionRecord(record, terminal, receipt.completedAt);
        record.requiresCredential = false;
        record.blocker = partial
          ? { code: "ROLLBACK_PARTIAL", message: "Rollback left resources that require manual reconciliation" }
          : undefined;
        await store.writeSession(record, secrets);
        await store.appendJournal(input.sessionId, {
          at: receipt.completedAt,
          event: "STATE_TRANSITION",
          from: "ROLLING_BACK",
          to: terminal,
          detail: partial ? "One or more fingerprint/ownership checks failed" : "All owned changes were reverted",
        }, secrets);
        await store.releaseLock(input.sessionId);
        lockHeld = false;
        return (await getSnapshot(input.sessionId))!;
      } finally {
        credentialCache.delete(input.sessionId);
        if (lockHeld) await store.releaseLock(input.sessionId).catch(() => undefined);
      }
    },

    async reconcile(input) {
      await initialize();
      const record = await requireSession(store, input.sessionId);
      if (input.credential === undefined) {
        if (record.status === "COMPLETE" || record.status === "ROLLED_BACK") {
          return (await getSnapshot(input.sessionId))!;
        }
        await requireCredentialReentry(store, record, now().toISOString(), "Reconciliation requires a fresh Cloudflare credential");
        return (await getSnapshot(input.sessionId))!;
      }
      const credential = input.credential;
      validateCredential(credential);
      const secrets = credentialSecrets(credential);
      credentialCache.set(input.sessionId, credential);
      try {
        await options.cloudflare.verifyCredential({ credential });
        const receipt = await store.readReceipt(input.sessionId);
        if (record.status === "NEEDS_CREDENTIAL_REENTRY" && receipt === undefined) {
          const restoredStatus = record.plan === undefined ? "PREFLIGHT" : "WAITING_FOR_CONFIRMATION";
          transitionRecord(record, restoredStatus, now().toISOString());
          record.requiresCredential = false;
          record.blocker = undefined;
          await store.writeSession(record, secrets);
          if (restoredStatus === "PREFLIGHT") credentialCache.set(input.sessionId, credential);
          return (await getSnapshot(input.sessionId))!;
        }
        if (record.status === "COMPLETE" || record.status === "ROLLED_BACK") {
          return (await getSnapshot(input.sessionId))!;
        }
        if (receipt === undefined || record.plan === undefined) {
          await requireCredentialReentry(store, record, now().toISOString(), "No Apply journal is available to reconcile");
          return (await getSnapshot(input.sessionId))!;
        }
        if (record.status === "NEEDS_CREDENTIAL_REENTRY") {
          transitionRecord(record, "NEEDS_RECONCILIATION", now().toISOString());
        }
        const plan = record.plan;
        const tunnelReceipt = receipt.resources.find((resource) => resource.kind === "tunnel");
        const dnsReceipt = receipt.resources.find((resource) => resource.kind === "dns");
        const serviceReceipt = receipt.resources.find((resource) => resource.kind === "cloudflared");
        const tunnels = await collectPages((page) =>
          options.cloudflare.listTunnels({ credential, accountId: plan.account.id, name: plan.actions.find((action) => action.kind === "tunnel")!.name, page, perPage: 50 }),
        );
        const tunnel = tunnels.find((candidate) => candidate.id === tunnelReceipt?.resourceId);
        const desiredConfig = desiredTunnelConfig(await requireManifest(store, input.sessionId));
        const currentConfig = tunnel === undefined
          ? undefined
          : await options.cloudflare.readTunnelConfig({ credential, accountId: plan.account.id, tunnelId: tunnel.id });
        const records = await collectPages((page) =>
          options.cloudflare.listDnsRecords({ credential, zoneId: plan.zone.id, name: (plan.actions.find((action) => action.kind === "dns")!).name, page, perPage: 50 }),
        );
        const dns = records.find((candidate) => candidate.id === dnsReceipt?.resourceId);
        const service = await options.cloudflared.inspect();
        const resourcesMatch =
          tunnel !== undefined &&
          currentConfig !== undefined &&
          fingerprint(currentConfig) === fingerprint(desiredConfig) &&
          dns !== undefined &&
          dns.content === `${tunnel.id}.cfargotunnel.com` &&
          dns.proxied === true &&
          service.serviceInstalled &&
          service.serviceId === serviceReceipt?.resourceId;
        if (resourcesMatch) {
          const tunnelHealth = await options.cloudflare.verifyTunnelHealth({ credential, accountId: plan.account.id, tunnelId: tunnel.id });
          const serviceHealth = await options.cloudflared.verify({ serviceId: service.serviceId! });
          receipt.verification = [
            { check: "tunnel_health", passed: tunnelHealth.healthy, checkedAt: tunnelHealth.checkedAt },
            { check: "cloudflared", passed: serviceHealth.healthy, checkedAt: serviceHealth.checkedAt },
          ];
          if (tunnelHealth.healthy && serviceHealth.healthy) {
            const from = record.status;
            if (from !== "VERIFYING") transitionRecord(record, "VERIFYING", now().toISOString());
            transitionRecord(record, "COMPLETE", now().toISOString());
            record.requiresCredential = false;
            record.blocker = undefined;
            receipt.completedAt = now().toISOString();
            await store.writeReceipt(receipt, secrets);
            await store.writeSession(record, secrets);
            await store.appendJournal(input.sessionId, {
              at: receipt.completedAt,
              event: "RECONCILED",
              from,
              to: "COMPLETE",
              detail: "Remote resources match the non-secret journal",
            }, secrets);
            return (await getSnapshot(input.sessionId))!;
          }
        }
        const from = record.status;
        if (from === "APPLYING" || from === "VERIFYING") {
          transitionRecord(record, "NEEDS_RECONCILIATION", now().toISOString());
        }
        record.requiresCredential = true;
        record.blocker = { code: "RECONCILIATION_REQUIRED", message: "Remote resources do not match the Apply journal; no writes were attempted" };
        await store.writeSession(record, secrets);
        await store.appendJournal(input.sessionId, {
          at: now().toISOString(),
          event: "RECONCILED",
          from,
          to: "NEEDS_RECONCILIATION",
          detail: record.blocker.message,
        }, secrets);
        return (await getSnapshot(input.sessionId))!;
      } finally {
        if ((await store.readSession(input.sessionId))?.status !== "PREFLIGHT") {
          credentialCache.delete(input.sessionId);
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
          now().toISOString(),
          "The in-memory Cloudflare credential was explicitly discarded",
        );
      }
    },
  };
}

async function buildPlan(input: {
  adapter: CloudflareAdapter;
  credential: CloudflareCredential;
  manifest: SetupManifest;
  account: CloudflareAccount;
  zone: CloudflareZone;
  tunnels: CloudflareTunnel[];
  dnsRecords: CloudflareDnsRecord[];
  serviceStatus: Awaited<ReturnType<CloudflaredAdapter["inspect"]>>;
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
      classification: "untouched",
      name: "publicBaseUrl",
      desiredFingerprint: fingerprint(input.manifest.publicMcpUrl),
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

function validateManifestDraft(draft: SetupManifestDraft, zoneName: string): void {
  if (!/^0\.5\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(draft.toolSpanVersion)) {
    throw new Error("Safe Manifest toolSpanVersion must be a 0.5.x version");
  }
  if (draft.instanceName.length < 1 || draft.instanceName.length > 80) {
    throw new Error("Safe Manifest instanceName must contain 1-80 characters");
  }
  if (draft.expectedToolCount !== 27) throw new Error("Setup requires the exact 27 Tool Contract");
  const local = new URL(draft.localUrl);
  if (
    local.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(local.hostname) ||
    local.username !== "" ||
    local.password !== "" ||
    local.search !== "" ||
    local.hash !== "" ||
    (local.pathname !== "/" && local.pathname !== "")
  ) {
    throw new Error("Setup localUrl must be an HTTP loopback URL");
  }
  const publicMcp = new URL(draft.publicMcpUrl);
  const oauth = new URL(draft.oauthDiscoveryUrl);
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
  if (publicMcp.hostname !== draft.desiredHostname || oauth.hostname !== draft.desiredHostname) {
    throw new Error("Public URLs must use the desired hostname");
  }
  if (draft.desiredHostname !== `mcp.${zoneName}` && !draft.desiredHostname.endsWith(`.${zoneName}`)) {
    throw new Error("Desired hostname must belong to the selected zone");
  }
  if (publicMcp.pathname !== "/mcp" || publicMcp.search !== "" || publicMcp.hash !== "") {
    throw new Error("Public MCP URL must use the exact /mcp endpoint without query or fragment");
  }
  if (!oauth.pathname.startsWith("/.well-known/") || oauth.search !== "" || oauth.hash !== "") {
    throw new Error("OAuth discovery URL must use an HTTPS /.well-known/ endpoint");
  }
  if (draft.tunnelName.length < 1 || draft.tunnelName.length > 100) {
    throw new Error("Safe Manifest tunnelName must contain 1-100 characters");
  }
  if (!["existing", "other_registrar", "namesilo_no_referral"].includes(draft.domainChoice)) {
    throw new Error("Safe Manifest domainChoice is invalid");
  }
  if (draft.officialDocs.length < 1 || draft.officialDocs.length > 32) {
    throw new Error("Safe Manifest requires 1-32 official docs URLs");
  }
  for (const doc of draft.officialDocs) {
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
  rollbackData?: NonNullable<import("./types.js").SetupJournalEntry["rollbackData"]>,
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
): Promise<import("./types.js").SetupLock | undefined> {
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
