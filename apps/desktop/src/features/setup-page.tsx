import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Cloud,
  ExternalLink,
  FileJson,
  KeyRound,
  LifeBuoy,
  LockKeyhole,
  RefreshCw,
  Route,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useDesktopAdapter } from "../adapters/context";
import type {
  SetupChatGptStatus,
  SetupCredential,
  SetupPath,
  SetupPhase,
  SetupResourceDisposition,
  SetupSafeManifest,
  SetupSnapshot,
} from "../adapters/types";
import { PageHeader } from "../components/page-header";
import { Badge, type BadgeTone } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { CopyButton } from "../components/ui/copy-button";
import { OperationError, SectionTitle, useRuntimeSnapshot } from "./shared";
import {
  chatGptSetupContent,
  commercialSetupContent,
  officialSetupDocs,
  type CommercialSetupContent,
  type GuideSetupContent,
} from "../lib/setup-content";

const GLOBAL_ACKNOWLEDGEMENT = "I UNDERSTAND GLOBAL API KEY ACCESS";

const PROMPT_FILES = [
  "cloudflare-browser.md",
  "cloudflare-terminal.md",
  "chatgpt-browser.md",
  "full-setup.md",
  "troubleshoot-setup.md",
] as const;

const MANUAL_STEP_KEYS = [
  "manualLocal",
  "manualZone",
  "manualTunnel",
  "manualIngress",
  "manualDns",
  "manualService",
  "manualPublic",
  "manualOauth",
  "manualHost",
] as const;

const CHECKPOINT_KEYS = [
  "checkpointAffiliate",
  "checkpointLogin",
  "checkpointSecret",
  "checkpointApply",
  "checkpointChatgpt",
  "checkpointVerify",
] as const;

function phaseTone(phase: SetupPhase): BadgeTone {
  if (phase === "COMPLETE" || phase === "ROLLED_BACK") return "positive";
  if (phase === "ROLLBACK_PARTIAL" || phase === "NEEDS_RECONCILIATION" || phase === "NEEDS_CREDENTIAL_REENTRY") return "warning";
  if (phase === "APPLYING" || phase === "ROLLING_BACK") return "danger";
  return "info";
}

function dispositionTone(disposition: SetupResourceDisposition): BadgeTone {
  if (disposition === "created") return "positive";
  if (disposition === "updated") return "warning";
  if (disposition === "reused") return "info";
  return "neutral";
}

function chatGptTone(status: SetupChatGptStatus): BadgeTone {
  if (status === "VALIDATED") return "positive";
  if (status === "BLOCKED_BY_HOST_PLAN_OR_POLICY") return "warning";
  return status === "USER_CONFIRMED" ? "info" : "neutral";
}

function validDomain(value: string): boolean {
  return /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/iu.test(value);
}

function safeTunnelName(instanceName: string): string {
  const slug = instanceName.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 40);
  return `toolspan-${slug || "instance"}`;
}

function SetupPathChooser({ active, onChange }: { active: SetupPath; onChange(path: SetupPath): void }) {
  const { t } = useTranslation();
  const paths: Array<{ id: SetupPath; icon: typeof Wrench; badge?: string }> = [
    { id: "guided_manual", icon: Wrench },
    { id: "scoped_api_token", icon: ShieldCheck, badge: t("setup.recommended") },
    { id: "global_api_key", icon: KeyRound, badge: t("setup.advancedLegacy") },
    { id: "agent_assisted", icon: Bot },
  ];
  const descriptions: Record<SetupPath, string> = {
    guided_manual: t("setup.manualPathDescription"),
    scoped_api_token: t("setup.scopedPathDescription"),
    global_api_key: t("setup.globalPathDescription"),
    agent_assisted: t("setup.agentPathDescription"),
  };
  const labels: Record<SetupPath, string> = {
    guided_manual: t("setup.manualPath"),
    scoped_api_token: t("setup.scopedPath"),
    global_api_key: t("setup.globalPath"),
    agent_assisted: t("setup.agentPath"),
  };
  return (
    <section aria-labelledby="setup-paths-title">
      <SectionTitle>{t("setup.pathsTitle")}</SectionTitle>
      <p className="section-description" id="setup-paths-title">{t("setup.pathsDescription")}</p>
      <div className="setup-path-grid">
        {paths.map(({ id, icon: Icon, badge }) => (
          <button
            aria-pressed={active === id}
            className="setup-path-card"
            key={id}
            onClick={() => onChange(id)}
            type="button"
          >
            <span className="setup-path-card__icon"><Icon aria-hidden="true" size={18} /></span>
            <span className="setup-path-card__body">
              <strong>{labels[id]}</strong>
              <small>{descriptions[id]}</small>
            </span>
            {badge === undefined ? null : <Badge tone={id === "scoped_api_token" ? "positive" : "warning"}>{badge}</Badge>}
          </button>
        ))}
      </div>
    </section>
  );
}

type DomainChoice = SetupSafeManifest["domainChoice"];

function DomainChooser({
  choice,
  commercial,
  onChange,
  snapshot,
}: {
  choice: DomainChoice;
  commercial: CommercialSetupContent;
  onChange(choice: DomainChoice): void;
  snapshot: SetupSnapshot;
}) {
  const { t } = useTranslation();
  return (
    <Card className="setup-domain-card">
      <SectionTitle>{t("setup.domainTitle")}</SectionTitle>
      <p className="section-description">{t("setup.domainDescription")}</p>
      <div className="domain-choice-grid" role="group" aria-label={t("setup.domainTitle")}>
        <button aria-pressed={choice === "existing"} className="domain-choice" onClick={() => onChange("existing")} type="button">
          {t("setup.alreadyDomain")}
        </button>
        <button aria-pressed={choice === "other_registrar"} className="domain-choice" onClick={() => onChange("other_registrar")} type="button">
          {t("setup.anyRegistrar")}
        </button>
        <a aria-current={choice === "namesilo_no_referral" ? "true" : undefined} className="domain-choice" href={commercial.directUrl} onClick={() => onChange("namesilo_no_referral")} rel="noreferrer" target="_blank">
          {t("setup.namesiloNoReferral")}<ExternalLink aria-hidden="true" size={13} />
        </a>
      </div>
      <div className="commercial-disclosure">
        <p>{t("setup.noReferralRule")}</p>
        <p>{snapshot.vendorAssets === "verified" ? t("setup.verifiedVendor") : t("setup.textOnlyVendor")}</p>
        <p><strong>{t("setup.registrarBoundary")}</strong></p>
      </div>
    </Card>
  );
}

interface CredentialFieldsProps {
  mode: "scoped_api_token" | "global_api_key";
  token: string;
  email: string;
  globalKey: string;
  acknowledgement: string;
  disabled: boolean;
  onToken(value: string): void;
  onEmail(value: string): void;
  onGlobalKey(value: string): void;
  onAcknowledgement(value: string): void;
}

function CredentialFields(props: CredentialFieldsProps) {
  const { t } = useTranslation();
  return (
    <div className="setup-credential-fields">
      {props.mode === "scoped_api_token" ? (
        <label className="field setup-field">
          <span>{t("setup.tokenLabel")}</span>
          <input
            autoComplete="off"
            disabled={props.disabled}
            name="setup-session-token"
            onChange={(event) => props.onToken(event.target.value)}
            placeholder={t("setup.tokenPlaceholder")}
            spellCheck={false}
            type="password"
            value={props.token}
          />
        </label>
      ) : (
        <>
          <div className="security-callout setup-global-warning" role="note">
            <AlertTriangle aria-hidden="true" size={18} />
            <strong>{t("setup.globalWarning")}</strong>
          </div>
          <div className="two-column setup-credential-pair">
            <label className="field setup-field">
              <span>{t("setup.emailLabel")}</span>
              <input autoComplete="off" disabled={props.disabled} onChange={(event) => props.onEmail(event.target.value)} spellCheck={false} type="email" value={props.email} />
            </label>
            <label className="field setup-field">
              <span>{t("setup.keyLabel")}</span>
              <input
                autoComplete="off"
                disabled={props.disabled}
                name="setup-session-global-key"
                onChange={(event) => props.onGlobalKey(event.target.value)}
                placeholder={t("setup.keyPlaceholder")}
                spellCheck={false}
                type="password"
                value={props.globalKey}
              />
            </label>
          </div>
          <label className="field setup-field setup-acknowledgement">
            <span>{t("setup.globalPhraseLabel")}</span>
            <input autoComplete="off" disabled={props.disabled} onChange={(event) => props.onAcknowledgement(event.target.value)} spellCheck={false} value={props.acknowledgement} />
            <small>{t("setup.globalPhraseHelp")} <code>{GLOBAL_ACKNOWLEDGEMENT}</code></small>
          </label>
        </>
      )}
      <p className="setup-secret-note"><LockKeyhole aria-hidden="true" size={15} />{t("setup.noRemember")}</p>
    </div>
  );
}

function ZoneGate({ snapshot }: { snapshot: SetupSnapshot }) {
  const { t } = useTranslation();
  const labels = {
    active: t("setup.zoneActive"),
    pending: t("setup.zonePending"),
    missing: t("setup.zoneMissing"),
    unknown: t("setup.zoneUnknown"),
  } as const;
  const tone: BadgeTone = snapshot.zone.status === "active" ? "positive" : snapshot.zone.status === "unknown" ? "neutral" : "warning";
  return (
    <Card className="setup-zone-card">
      <SectionTitle meta={<Badge tone={tone}>{labels[snapshot.zone.status]}</Badge>}>{t("setup.zoneTitle")}</SectionTitle>
      <div className="setup-id-grid">
        <div><span>{t("setup.accountId")}</span><code>{snapshot.zone.accountId ?? "—"}</code></div>
        <div><span>{t("setup.zoneId")}</span><code>{snapshot.zone.zoneId ?? "—"}</code></div>
      </div>
      {snapshot.zone.status === "pending" ? (
        <div className="setup-zone-guidance" role="status">
          <strong>{t("setup.assignedNameservers")}</strong>
          <ul>{snapshot.zone.assignedNameservers.map((nameserver) => <li key={nameserver}><code>{nameserver}</code></li>)}</ul>
          <p>{t("setup.pendingGuidance")}</p>
        </div>
      ) : null}
      {snapshot.zone.status === "missing" ? <p className="setup-zone-guidance" role="status">{t("setup.missingGuidance")}</p> : null}
      {snapshot.zone.status !== "active" ? <p className="setup-gate-stop"><AlertTriangle aria-hidden="true" size={16} />{t("setup.activeRequired")}</p> : null}
    </Card>
  );
}

function DryRun({ snapshot }: { snapshot: SetupSnapshot }) {
  const { t } = useTranslation();
  return (
    <Card>
      <SectionTitle meta={<Badge tone="positive">{t("setup.sideEffectsZero")}</Badge>}>{t("setup.dryRunTitle")}</SectionTitle>
      <p className="section-description">{t("setup.dryRunDescription")}</p>
      {snapshot.plan === null ? <p className="empty-state">{t("setup.noPlan")}</p> : (
        <>
          <div className="setup-plan-list">
            {snapshot.plan.items.map((item) => (
              <div className="setup-plan-row" key={item.id}>
                <Badge tone={dispositionTone(item.disposition)}>{t(`setup.${item.disposition}`)}</Badge>
                <div><strong>{item.resource}</strong><p>{item.summary}</p></div>
              </div>
            ))}
          </div>
          {snapshot.plan.warnings.length === 0 ? null : <div className="setup-plan-warnings"><strong>{t("setup.planWarnings")}</strong><ul>{snapshot.plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
        </>
      )}
    </Card>
  );
}

function VerificationReceipt({ snapshot }: { snapshot: SetupSnapshot }) {
  const { t } = useTranslation();
  if (snapshot.verificationEvidence.length === 0 && snapshot.duplicateCreates === null) return null;
  return (
    <Card className="setup-receipt-card">
      <SectionTitle>{t("setup.receiptTitle")}</SectionTitle>
      <p className="section-description">{t("setup.receiptDescription")}</p>
      {snapshot.duplicateCreates === null ? null : (
        <div className="setup-duplicate-count"><span>{t("setup.duplicateCreates")}</span><strong>{snapshot.duplicateCreates}</strong></div>
      )}
      <div className="setup-evidence-list">
        {snapshot.verificationEvidence.map((evidence) => (
          <div key={evidence.check}>
            <Badge tone={evidence.passed ? "positive" : "danger"}>{evidence.passed ? t("setup.evidencePassed") : t("setup.evidenceFailed")}</Badge>
            <span><strong>{evidence.check}</strong>{evidence.detail === null ? null : <small>{evidence.detail}</small>}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ManualTutorial() {
  const { t } = useTranslation();
  return (
    <Card>
      <SectionTitle>{t("setup.manualTitle")}</SectionTitle>
      <p className="section-description">{t("setup.manualDescription")}</p>
      <p className="setup-quick-tunnel-note">{t("setup.quickTunnelNote")}</p>
      <ol className="manual-setup-list">
        {MANUAL_STEP_KEYS.map((key, index) => {
          const step = t(`setup.${key}`);
          return (
            <li key={key}>
              <span className="manual-step-number" aria-hidden="true">{index + 1}</span>
              <div>
                <h3>{step}</h3>
                <dl>
                  <div><dt>{t("setup.purpose")}</dt><dd>{t("setup.manualPurpose", { step })}</dd></div>
                  <div><dt>{t("setup.action")}</dt><dd>{step}</dd></div>
                  <div><dt>{t("setup.expected")}</dt><dd>{t("setup.manualExpected")}</dd></div>
                  <div><dt>{t("setup.failure")}</dt><dd>{t("setup.manualFailure")}</dd></div>
                  <div><dt>{t("setup.recovery")}</dt><dd>{t("setup.manualRecovery")}</dd></div>
                </dl>
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function AgentPack({ manifest }: { manifest: SetupSafeManifest }) {
  const { t } = useTranslation();
  const manifestText = JSON.stringify(manifest, null, 2);
  return (
    <div className="two-column setup-agent-grid">
      <Card>
        <SectionTitle meta={<FileJson aria-hidden="true" size={18} />}>{t("setup.safeManifest")}</SectionTitle>
        <pre className="setup-manifest-preview">{manifestText}</pre>
        <CopyButton label={t("setup.copyManifest")} value={manifestText} />
      </Card>
      <Card>
        <SectionTitle>{t("setup.promptPack")}</SectionTitle>
        <ul className="setup-file-list">{PROMPT_FILES.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
        <h3>{t("setup.checkpoints")}</h3>
        <div className="setup-checkpoints">{CHECKPOINT_KEYS.map((key) => <Badge key={key} tone="warning">{t(`setup.${key}`)}</Badge>)}</div>
        <p className="setup-agent-warning">{t("setup.promptSafety")}</p>
      </Card>
    </div>
  );
}

function ChatGptGuide({ manifest, initialStatus, guide }: { manifest: SetupSafeManifest; initialStatus: SetupChatGptStatus; guide: GuideSetupContent }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState(initialStatus);
  useEffect(() => setStatus(initialStatus), [initialStatus]);
  const labels: Record<SetupChatGptStatus, string> = {
    MANUAL_PENDING: t("setup.chatgptManualPending"),
    USER_CONFIRMED: t("setup.chatgptUserConfirmed"),
    VALIDATED: t("setup.chatgptValidated"),
    BLOCKED_BY_HOST_PLAN_OR_POLICY: t("setup.chatgptBlocked"),
  };
  const fields = [
    { label: t("setup.appName"), value: manifest.instanceName },
    { label: t("setup.publicMcpUrl"), value: manifest.publicMcpUrl },
    { label: t("setup.oauthUrl"), value: manifest.oauthDiscoveryUrl },
    { label: t("setup.expectedTools"), value: String(manifest.expectedToolCount) },
    { label: t("setup.readPrompt"), value: "List the available ToolSpan tools and perform no writes. Expected: exactly 27 tools." },
    { label: t("setup.writePrompt"), value: "In the designated synthetic E2E workspace only, perform the approved write verification and report evidence." },
  ];
  return (
    <Card>
      <SectionTitle meta={<Badge tone={chatGptTone(status)}>{labels[status]}</Badge>}>{t("setup.chatgptTitle")}</SectionTitle>
      <p className="section-description">{t("setup.chatgptDescription")}</p>
      {!guide.current ? <p className="setup-stale-guide">{t("setup.staleGuide")} {guide.fallbackText}</p> : null}
      {guide.current && guide.developerModePath.length > 0 ? (
        <p className="setup-guide-path"><strong>{t("setup.guidePath")}</strong><span>{guide.developerModePath.join(" → ")}</span></p>
      ) : null}
      <div className="setup-copy-grid">
        {fields.map((field) => (
          <div className="copy-field" key={field.label}><span><strong>{field.label}</strong><code>{field.value}</code></span><CopyButton compact label={`${t("common.copy")} ${field.label}`} value={field.value} /></div>
        ))}
      </div>
      <div className="button-row setup-chatgpt-actions">
        <a className="button button--secondary button--normal" href={guide.sourceUrl} rel="noreferrer" target="_blank">{t("setup.currentGuide")}<ExternalLink aria-hidden="true" size={14} /></a>
        {guide.connectionUrl === null ? null : <a className="button button--secondary button--normal" href={guide.connectionUrl} rel="noreferrer" target="_blank">{t("setup.openConnectionPage")}<ExternalLink aria-hidden="true" size={14} /></a>}
        {status === "MANUAL_PENDING" ? <Button onClick={() => setStatus("USER_CONFIRMED")}>{t("setup.confirmChatgpt")}</Button> : null}
        {status !== "VALIDATED" && status !== "BLOCKED_BY_HOST_PLAN_OR_POLICY" ? <Button onClick={() => setStatus("BLOCKED_BY_HOST_PLAN_OR_POLICY")}>{t("setup.markBlocked")}</Button> : null}
      </div>
      <p className="setup-truthful-status">{t("setup.confirmNotValidation")}</p>
    </Card>
  );
}

export function SetupPage() {
  const { t } = useTranslation();
  const adapter = useDesktopAdapter();
  const runtime = useRuntimeSnapshot();
  const setupQuery = useQuery({ queryKey: ["setup-snapshot"], queryFn: () => adapter.getSetupSnapshot() });
  const [current, setCurrent] = useState<SetupSnapshot | null>(null);
  const [path, setPath] = useState<SetupPath>("scoped_api_token");
  const [domainChoice, setDomainChoice] = useState<DomainChoice>("existing");
  const [domain, setDomain] = useState("");
  const [hostname, setHostname] = useState("");
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [globalKey, setGlobalKey] = useState("");
  const [acknowledgement, setAcknowledgement] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentialPreparedForApply, setCredentialPreparedForApply] = useState(false);
  const draftSessionId = useRef<string>(globalThis.crypto.randomUUID());
  const idempotencyKeyRef = useRef<string>(globalThis.crypto.randomUUID());
  const sessionIdRef = useRef<string>(draftSessionId.current);
  const commercial = useMemo(() => commercialSetupContent(), []);
  const guide = useMemo(() => chatGptSetupContent(), []);
  const officialDocs = useMemo(() => officialSetupDocs(), []);

  const idleSnapshot = useMemo<SetupSnapshot>(() => {
    const source = runtime.data;
    return {
      sessionId: draftSessionId.current,
      phase: "IDLE",
      path: null,
      domain: "",
      desiredHostname: "",
      zone: { exists: false, status: "unknown", accountId: null, zoneId: null, assignedNameservers: [] },
      plan: null,
      rollback: null,
      verificationEvidence: [],
      duplicateCreates: null,
      requiresCredential: false,
      safeManifest: {
        schemaVersion: "1.0",
        toolSpanVersion: source?.core.version ?? "unknown",
        instanceName: source?.instanceName ?? "ToolSpan",
        localUrl: source?.connection.localUrl ?? "",
        desiredHostname: "",
        publicMcpUrl: "",
        oauthDiscoveryUrl: "",
        expectedToolCount: 27,
        tunnelName: safeTunnelName(source?.instanceName ?? "instance"),
        domainChoice: "existing",
        officialDocs,
        generatedAt: new Date().toISOString(),
      },
      chatGptStatus: "MANUAL_PENDING",
      guideCurrent: guide.current,
      commercialOffer: { current: commercial.current, example: commercial.example, coupon: commercial.coupon },
      vendorAssets: "text_only_fallback",
      lastErrorCode: null,
    };
  }, [commercial, guide.current, officialDocs, runtime.data]);
  const snapshot = current ?? setupQuery.data ?? idleSnapshot;
  useEffect(() => {
    sessionIdRef.current = snapshot.sessionId || draftSessionId.current;
    setDomain((value) => value || snapshot.domain);
    setHostname((value) => value || snapshot.desiredHostname);
    if (snapshot.path !== null) setPath(snapshot.path);
  }, [snapshot]);

  const clearCredentialFields = () => {
    setToken("");
    setEmail("");
    setGlobalKey("");
    setAcknowledgement("");
  };

  useEffect(() => () => {
    void adapter.discardSetupCredential(sessionIdRef.current);
  }, [adapter]);

  const manifest = useMemo<SetupSafeManifest>(() => {
    const source = runtime.data;
    const effectiveHostname = hostname.trim().toLowerCase();
    const publicOrigin = effectiveHostname === "" ? "" : `https://${effectiveHostname}`;
    return {
      schemaVersion: snapshot?.safeManifest.schemaVersion ?? "1.0",
      toolSpanVersion: source?.core.version ?? snapshot?.safeManifest.toolSpanVersion ?? "unknown",
      instanceName: source?.instanceName ?? snapshot?.safeManifest.instanceName ?? "ToolSpan",
      localUrl: source?.connection.localUrl ?? snapshot?.safeManifest.localUrl ?? "",
      desiredHostname: effectiveHostname,
      publicMcpUrl: publicOrigin === "" ? "" : `${publicOrigin}/mcp`,
      oauthDiscoveryUrl: publicOrigin === "" ? "" : `${publicOrigin}/.well-known/oauth-authorization-server`,
      expectedToolCount: 27,
      tunnelName: safeTunnelName(source?.instanceName ?? snapshot?.safeManifest.instanceName ?? "instance"),
      domainChoice,
      officialDocs,
      generatedAt: new Date().toISOString(),
    };
  }, [domainChoice, hostname, officialDocs, runtime.data, snapshot]);

  if (setupQuery.isPending || runtime.isPending) {
    return (
      <div className="page-stack setup-page">
        <PageHeader description={t("setup.description")} eyebrow={t("setup.eyebrow")} title={t("setup.title")} />
        <p>{t("common.loading")}</p>
      </div>
    );
  }
  if (setupQuery.isError || runtime.isError) {
    return (
      <div className="page-stack setup-page">
        <PageHeader description={t("setup.description")} eyebrow={t("setup.eyebrow")} title={t("setup.title")} />
        <OperationError />
      </div>
    );
  }

  const credentialMode = path === "global_api_key" ? "global_api_key" : "scoped_api_token";
  const makeCredential = (): SetupCredential | null => {
    if (credentialMode === "scoped_api_token") return token.trim() === "" ? null : { kind: "api_token", token };
    if (email.trim() === "" || globalKey === "" || acknowledgement !== GLOBAL_ACKNOWLEDGEMENT) return null;
    return { kind: "global_api_key", email: email.trim(), key: globalKey, acknowledgement: GLOBAL_ACKNOWLEDGEMENT };
  };

  const credentialValidationMessage = () => {
    if (credentialMode === "global_api_key" && acknowledgement !== GLOBAL_ACKNOWLEDGEMENT) return t("setup.phraseRequired");
    return t("setup.credentialRequired");
  };

  const runWithCredential = async (operation: "preflight" | "reconcile" | "rollback") => {
    const normalizedDomain = domain.trim().toLowerCase();
    const normalizedHostname = hostname.trim().toLowerCase();
    if (!validDomain(normalizedDomain) || !validDomain(normalizedHostname) || (normalizedHostname !== normalizedDomain && !normalizedHostname.endsWith(`.${normalizedDomain}`))) {
      setError(t("setup.targetRequired"));
      return;
    }
    const credential = makeCredential();
    if (credential === null) {
      setError(credentialValidationMessage());
      return;
    }
    const sessionId = sessionIdRef.current;
    clearCredentialFields();
    setBusy(true);
    setError(null);
    try {
      await adapter.setSetupCredential(sessionId, credential);
      const result = operation === "preflight"
        ? await adapter.setupPreflight(sessionId, idempotencyKeyRef.current, domain.trim().toLowerCase(), manifest)
        : operation === "reconcile"
          ? await adapter.setupReconcile(sessionId)
          : await adapter.setupRollback(sessionId);
      setCurrent(result);
      if (operation === "reconcile" && result.phase === "WAITING_FOR_CONFIRMATION") setCredentialPreparedForApply(true);
      if (operation === "rollback") await adapter.discardSetupCredential(sessionId);
    } catch {
      setError(t("setup.operationFailed"));
      const refreshed = await adapter.getSetupSnapshot(sessionId).catch(() => null);
      if (refreshed !== null) setCurrent(refreshed);
    } finally {
      setBusy(false);
    }
  };

  const prepareApplyCredential = async () => {
    const credential = makeCredential();
    if (credential === null) {
      setError(credentialValidationMessage());
      return;
    }
    const sessionId = sessionIdRef.current;
    clearCredentialFields();
    setBusy(true);
    setError(null);
    try {
      await adapter.setSetupCredential(sessionId, credential);
      setCredentialPreparedForApply(true);
    } catch {
      setCredentialPreparedForApply(false);
      setError(t("setup.operationFailed"));
    } finally {
      setBusy(false);
    }
  };

  const changePath = (nextPath: SetupPath) => {
    clearCredentialFields();
    setError(null);
    void adapter.discardSetupCredential(sessionIdRef.current);
    setCredentialPreparedForApply(false);
    setPath(nextPath);
  };

  const cancelSession = () => {
    clearCredentialFields();
    setError(null);
    void adapter.discardSetupCredential(sessionIdRef.current);
    setCredentialPreparedForApply(false);
  };

  const generatePlan = async () => {
    setCredentialPreparedForApply(false);
    setBusy(true);
    setError(null);
    try { setCurrent(await adapter.setupPlan(sessionIdRef.current)); }
    catch {
      setError(t("setup.operationFailed"));
      const refreshed = await adapter.getSetupSnapshot(sessionIdRef.current).catch(() => null);
      if (refreshed !== null) setCurrent(refreshed);
    }
    finally { setBusy(false); }
  };

  const applyPlan = async () => {
    setBusy(true);
    setError(null);
    try { setCurrent(await adapter.setupApply(sessionIdRef.current)); }
    catch {
      setError(t("setup.operationFailed"));
      const refreshed = await adapter.getSetupSnapshot(sessionIdRef.current).catch(() => null);
      if (refreshed !== null) setCurrent(refreshed);
    }
    finally {
      setCredentialPreparedForApply(false);
      clearCredentialFields();
      await adapter.discardSetupCredential(sessionIdRef.current).catch(() => undefined);
      setBusy(false);
    }
  };

  const zoneVerifiedActive = snapshot.zone.exists && snapshot.zone.status === "active" && snapshot.phase !== "IDLE";
  const canGeneratePlan = snapshot.phase === "PREFLIGHT";
  const waitingForApply = snapshot.plan !== null && snapshot.phase === "WAITING_FOR_CONFIRMATION";
  const credentialEntryNeeded = snapshot.phase === "IDLE" || waitingForApply;
  const canApply = zoneVerifiedActive && waitingForApply && credentialPreparedForApply;
  const recoveryNeeded = snapshot.requiresCredential || ["NEEDS_CREDENTIAL_REENTRY", "NEEDS_RECONCILIATION", "ROLLBACK_PARTIAL"].includes(snapshot.phase);
  const credentialRecoveryNeeded = snapshot.requiresCredential || ["NEEDS_CREDENTIAL_REENTRY", "NEEDS_RECONCILIATION"].includes(snapshot.phase);
  const terminalSession = ["COMPLETE", "ROLLED_BACK", "ROLLBACK_PARTIAL"].includes(snapshot.phase);

  const startNewSession = () => {
    void adapter.discardSetupCredential(sessionIdRef.current);
    draftSessionId.current = globalThis.crypto.randomUUID();
    idempotencyKeyRef.current = globalThis.crypto.randomUUID();
    sessionIdRef.current = draftSessionId.current;
    clearCredentialFields();
    setCredentialPreparedForApply(false);
    setError(null);
    setDomain("");
    setHostname("");
    setPath("scoped_api_token");
    setCurrent({
      ...idleSnapshot,
      sessionId: draftSessionId.current,
      safeManifest: { ...idleSnapshot.safeManifest, generatedAt: new Date().toISOString() },
    });
  };

  return (
    <div className="page-stack setup-page">
      <PageHeader
        actions={(
          <div className="button-row">
            <Badge tone={phaseTone(snapshot.phase)}>{snapshot.phase}</Badge>
            {terminalSession ? <Button onClick={startNewSession} size="compact">{t("setup.newSession")}</Button> : null}
          </div>
        )}
        description={t("setup.description")}
        eyebrow={t("setup.eyebrow")}
        title={t("setup.title")}
      />
      {snapshot.lastErrorCode === null ? null : <p className="setup-blocker-code" role="status">{t("setup.blockerCode", { code: snapshot.lastErrorCode })}</p>}
      <SetupPathChooser active={path} onChange={changePath} />

      {path === "guided_manual" ? <ManualTutorial /> : null}

      {path === "scoped_api_token" || path === "global_api_key" ? (
        <>
          <DomainChooser choice={domainChoice} commercial={commercial} onChange={setDomainChoice} snapshot={snapshot} />
          {!recoveryNeeded && credentialEntryNeeded ? <Card>
            <SectionTitle meta={<Cloud aria-hidden="true" size={18} />}>{t("setup.credentialsTitle")}</SectionTitle>
            <div className="two-column setup-target-fields">
              <label className="field setup-field"><span>{t("setup.domainLabel")}</span><input autoComplete="off" disabled={busy || waitingForApply} onChange={(event) => setDomain(event.target.value)} placeholder={t("setup.domainPlaceholder")} spellCheck={false} value={domain} /></label>
              <label className="field setup-field"><span>{t("setup.hostnameLabel")}</span><input autoComplete="off" disabled={busy || waitingForApply} onChange={(event) => setHostname(event.target.value)} placeholder={t("setup.hostnamePlaceholder")} spellCheck={false} value={hostname} /></label>
            </div>
            <CredentialFields
              acknowledgement={acknowledgement}
              disabled={busy}
              email={email}
              globalKey={globalKey}
              mode={credentialMode}
              onAcknowledgement={setAcknowledgement}
              onEmail={setEmail}
              onGlobalKey={setGlobalKey}
              onToken={setToken}
              token={token}
            />
            {error === null ? null : <p className="inline-error" role="alert">{error}</p>}
            {credentialPreparedForApply ? <p className="setup-credential-ready" role="status">{t("setup.applyCredentialReady")}</p> : null}
            <div className="button-row setup-submit-row">
              <Button
                disabled={busy}
                onClick={() => { if (waitingForApply) void prepareApplyCredential(); else void runWithCredential("preflight"); }}
                variant="primary"
              >
                <ShieldCheck aria-hidden="true" size={15} />{waitingForApply ? t("setup.prepareApplyCredential") : t("setup.verifyPreflight")}
              </Button>
              <Button disabled={busy} onClick={cancelSession}>{t("setup.cancelSession")}</Button>
            </div>
          </Card> : null}
          <div className="two-column setup-gates-grid">
            <ZoneGate snapshot={snapshot} />
            <DryRun snapshot={snapshot} />
          </div>
          <Card className="setup-apply-card">
            <div>
              <strong>{t("setup.cloudflaredBoundary")}</strong>
              <p>{t("setup.rotateGuidance")}</p>
            </div>
            <div className="button-row">
              <Button disabled={!canGeneratePlan || busy} onClick={() => { void generatePlan(); }}><Route aria-hidden="true" size={15} />{t("setup.generatePlan")}</Button>
              <ConfirmDialog
                confirmLabel={t("setup.apply")}
                description={path === "global_api_key" ? t("setup.globalApplyDescription") : t("setup.applyDescription")}
                onCancel={cancelSession}
                onConfirm={() => { void applyPlan(); }}
                title={path === "global_api_key" ? t("setup.globalApplyTitle") : t("setup.applyTitle")}
                trigger={<Button disabled={!canApply || busy} variant="primary"><CheckCircle2 aria-hidden="true" size={15} />{t("setup.apply")}</Button>}
              />
            </div>
          </Card>
          <VerificationReceipt snapshot={snapshot} />
          {recoveryNeeded ? (
            <Card className="setup-recovery-card" tone="accent">
              <SectionTitle meta={<LifeBuoy aria-hidden="true" size={18} />}>{t("setup.recoveryTitle")}</SectionTitle>
              {credentialRecoveryNeeded ? (
                <>
                  <h3>{t("setup.reentryTitle")}</h3>
                  <p>{t("setup.reentryDescription")}</p>
                  <CredentialFields
                    acknowledgement={acknowledgement}
                    disabled={busy}
                    email={email}
                    globalKey={globalKey}
                    mode={credentialMode}
                    onAcknowledgement={setAcknowledgement}
                    onEmail={setEmail}
                    onGlobalKey={setGlobalKey}
                    onToken={setToken}
                    token={token}
                  />
                  <div className="button-row">
                    <Button disabled={busy} onClick={() => { void runWithCredential("reconcile"); }}><RefreshCw aria-hidden="true" size={15} />{t("setup.reconcile")}</Button>
                    <ConfirmDialog
                      confirmLabel={t("setup.rollback")}
                      description={t("setup.reentryDescription")}
                      destructive
                      onCancel={cancelSession}
                      onConfirm={() => { void runWithCredential("rollback"); }}
                      title={t("setup.rollback")}
                      trigger={<Button disabled={busy} variant="danger">{t("setup.rollback")}</Button>}
                    />
                  </div>
                </>
              ) : null}
              {snapshot.rollback === null ? null : (
                <div className="setup-rollback-result">
                  <Badge tone={snapshot.rollback.status === "full" ? "positive" : "warning"}>{snapshot.rollback.status === "full" ? t("setup.rollbackFull") : t("setup.rollbackPartial")}</Badge>
                  {snapshot.rollback.remainingResources.length === 0 ? null : <div><strong>{t("setup.remainingResources")}</strong><ul>{snapshot.rollback.remainingResources.map((item) => <li key={item}>{item}</li>)}</ul></div>}
                  {snapshot.rollback.manualSteps.length === 0 ? null : <div><strong>{t("setup.manualSteps")}</strong><ol>{snapshot.rollback.manualSteps.map((item) => <li key={item}>{item}</li>)}</ol></div>}
                </div>
              )}
            </Card>
          ) : null}
        </>
      ) : null}

      {path === "agent_assisted" ? (
        <>
          <Card className="setup-agent-heading" tone="accent"><Bot aria-hidden="true" size={20} /><div><h2>{t("setup.agentTitle")}</h2><p>{t("setup.agentDescription")}</p></div></Card>
          <AgentPack manifest={manifest} />
        </>
      ) : null}

      <ChatGptGuide guide={guide} initialStatus={snapshot.chatGptStatus} manifest={manifest} />
    </div>
  );
}
