import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveNpmCli, verificationEnvironment } from "./desktop-install.mjs";
import { npmCommand } from "./desktop-verification-utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(scriptDirectory, "..");
export const releaseEvidenceRoot = path.join(projectRoot, ".toolspan-dev", "evidence", "release");
const externalEvidenceRoot = path.join(projectRoot, ".toolspan-dev", "evidence", "external");

export const RELEASE_GATE_MATRIX = [
  { id: "E-OWNER-01", required: true, allowed: ["PASS", "EXTERNAL_GATE_PENDING"], fallback: "EXTERNAL_GATE_PENDING" },
  { id: "E-GH-01", required: true, allowed: ["PASS", "EXTERNAL_GATE_PENDING"], fallback: "EXTERNAL_GATE_PENDING" },
  { id: "E-WIN-01", required: true, allowed: ["PASS", "EXTERNAL_GATE_PENDING", "BLOCKED_BY_ENVIRONMENT"], fallback: "EXTERNAL_GATE_PENDING" },
  { id: "E-SIGN-01", required: false, allowed: ["PASS", "NOT_CONFIGURED"], fallback: "NOT_CONFIGURED" },
  { id: "E-CF-TOKEN-01", required: "ONE_CLICK_CLOUDFLARE_VALIDATED", allowed: ["PASS", "EXTERNAL_GATE_PENDING"], fallback: "EXTERNAL_GATE_PENDING" },
  { id: "E-CF-WIN-01", required: "WINDOWS_ONE_CLICK_VALIDATED", allowed: ["PASS", "EXTERNAL_GATE_PENDING", "BLOCKED_BY_ENVIRONMENT"], fallback: "BLOCKED_BY_ENVIRONMENT" },
  { id: "E-HOST-01", required: true, allowed: ["PASS", "FAIL"], fallback: "FAIL" },
  { id: "E-CODEX-01", required: true, allowed: ["PASS", "EXTERNAL_GATE_PENDING"], fallback: "EXTERNAL_GATE_PENDING" },
  { id: "E-CGPT-UI-01", required: false, allowed: ["PASS", "BLOCKED_BY_HOST_PLAN_OR_POLICY", "EXTERNAL_GATE_PENDING"], fallback: "EXTERNAL_GATE_PENDING" },
  { id: "E-OAUTH-SOAK-01", required: false, allowed: ["PASS", "NOT_REQUIRED", "EXTERNAL_GATE_PENDING"], fallback: "NOT_REQUIRED" },
  { id: "E-AFF-01", required: "COMMERCIAL_CTA_CURRENT", allowed: ["PASS", "STALE_FALLBACK", "EXTERNAL_GATE_PENDING"], fallback: "EXTERNAL_GATE_PENDING" },
  { id: "E-ASSET-01", required: "VENDOR_ASSET_CLAIM", allowed: ["PASS", "TEXT_ONLY_FALLBACK"], fallback: "TEXT_ONLY_FALLBACK" },
  { id: "E-DATA-01", required: "NUMERIC_OPENAI_QUOTA_CLAIM", allowed: ["PASS", "STALE_FALLBACK", "EXTERNAL_GATE_PENDING"], fallback: "EXTERNAL_GATE_PENDING" },
];

export const RELEASE_GATE_MAX_AGE_DAYS = Object.freeze({
  "E-OWNER-01": 365,
  "E-GH-01": 7,
  "E-WIN-01": 7,
  "E-SIGN-01": 30,
  "E-CF-TOKEN-01": 7,
  "E-CF-WIN-01": 30,
  "E-HOST-01": 7,
  "E-CODEX-01": 7,
  "E-CGPT-UI-01": 30,
  "E-OAUTH-SOAK-01": 7,
  "E-AFF-01": 30,
  "E-ASSET-01": 365,
  "E-DATA-01": 30,
});

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

export const RELEASE_CLAIM_POLICY = Object.freeze({
  ONE_CLICK_CLOUDFLARE_VALIDATED: Object.freeze({
    active: true,
    basis: "SETUP_ONE_CLICK_CLOUDFLARE_FLOW_PRESENT",
  }),
  WINDOWS_ONE_CLICK_VALIDATED: Object.freeze({
    active: false,
    basis: "WINDOWS_SETUP_USES_MANUAL_CLOUDFLARED_ONLY",
  }),
  COMMERCIAL_CTA_CURRENT: Object.freeze({
    active: false,
    basis: "REFERRAL_CTA_REMOVED",
  }),
  VENDOR_ASSET_CLAIM: Object.freeze({
    active: false,
    basis: "TEXT_ONLY_FALLBACK_ACTIVE",
  }),
  NUMERIC_OPENAI_QUOTA_CLAIM: Object.freeze({
    active: true,
    basis: "NUMERIC_OPENAI_QUOTA_CONTENT_PRESENT",
  }),
});

export function claimPolicyFromOpenAiSnapshot(openAiSnapshot) {
  let snapshot;
  try {
    if (typeof openAiSnapshot === "string") snapshot = JSON.parse(openAiSnapshot);
    else if (ArrayBuffer.isView(openAiSnapshot)) {
      snapshot = JSON.parse(Buffer.from(
        openAiSnapshot.buffer,
        openAiSnapshot.byteOffset,
        openAiSnapshot.byteLength,
      ).toString("utf8"));
    } else snapshot = openAiSnapshot;
  } catch {
    snapshot = null;
  }
  if (snapshot?.verificationStatus !== "INCOMPLETE_OFFICIAL_COVERAGE") {
    return RELEASE_CLAIM_POLICY;
  }
  return Object.freeze({
    ...RELEASE_CLAIM_POLICY,
    NUMERIC_OPENAI_QUOTA_CLAIM: Object.freeze({
      active: false,
      basis: "OFFICIAL_SOURCE_COVERAGE_INCOMPLETE_STALE_FALLBACK",
    }),
  });
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function sha256Content(value) {
  return createHash("sha256").update(value).digest("hex");
}

function currentReleaseContextFromManifests(artifactManifest, desktopManifest, snapshots) {
  if (artifactManifest === null || typeof artifactManifest !== "object"
    || desktopManifest === null || typeof desktopManifest !== "object"
    || typeof artifactManifest.toolSpanVersion !== "string"
    || desktopManifest.toolSpanVersion !== artifactManifest.toolSpanVersion
    || !Array.isArray(desktopManifest.nativeArtifacts)
    || desktopManifest.nativeArtifacts.length !== 2) return null;
  const msi = desktopManifest.nativeArtifacts.filter((entry) => (
    entry !== null && typeof entry === "object"
      && typeof entry.targetName === "string" && entry.targetName.toLowerCase().endsWith(".msi")
  ));
  const nsis = desktopManifest.nativeArtifacts.filter((entry) => (
    entry !== null && typeof entry === "object"
      && typeof entry.targetName === "string" && entry.targetName.toLowerCase().endsWith(".exe")
  ));
  if (msi.length !== 1 || nsis.length !== 1 || !sha256(msi[0].sha256) || !sha256(nsis[0].sha256)) {
    return null;
  }
  return Object.freeze({
    toolSpanVersion: artifactManifest.toolSpanVersion,
    msiSha256: msi[0].sha256,
    nsisSha256: nsis[0].sha256,
    affiliateSnapshotSha256: sha256Content(snapshots.affiliate),
    openAiSnapshotSha256: sha256Content(snapshots.openAi),
  });
}

function datedIso(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)
    && !Number.isNaN(Date.parse(value));
}

function observedAtIsCurrent(value, gate, now = new Date()) {
  if (!datedIso(value) || !(now instanceof Date) || Number.isNaN(now.getTime())) return false;
  const maxAgeDays = RELEASE_GATE_MAX_AGE_DAYS[gate.id];
  if (!Number.isInteger(maxAgeDays) || maxAgeDays <= 0) return false;
  const age = now.getTime() - Date.parse(value);
  return age >= 0 && age <= maxAgeDays * DAY_MILLISECONDS;
}

function exactObject(value, expectedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function sha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function cloudflareId(value) {
  return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
}

function remoteHttpsUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
  } catch {
    return false;
  }
}

function httpEndpoint(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}

function validateCodexProof(proof) {
  if (!exactObject(proof, [
    "kind", "remoteInstanceUrl", "devspaceInfoConfirmed", "toolCount", "readPassed",
    "writePassed", "jobPassed", "remoteBeforeSha256", "remoteAfterSha256",
    "localBeforeSha256", "localAfterSha256",
  ])) return false;
  return proof.kind === "CODEX_REMOTE_E2E"
    && remoteHttpsUrl(proof.remoteInstanceUrl)
    && proof.devspaceInfoConfirmed === true
    && proof.toolCount === 27
    && proof.readPassed === true
    && proof.writePassed === true
    && proof.jobPassed === true
    && sha256(proof.remoteBeforeSha256)
    && sha256(proof.remoteAfterSha256)
    && proof.remoteBeforeSha256 !== proof.remoteAfterSha256
    && sha256(proof.localBeforeSha256)
    && sha256(proof.localAfterSha256)
    && proof.localBeforeSha256 === proof.localAfterSha256;
}

function validateInspectorProof(proof) {
  if (!exactObject(proof, [
    "kind", "inspectorPackage", "inspectorVersion", "endpoint", "initializePassed",
    "toolCount", "readPassed", "mutationPassed", "insufficientScopePassed",
  ])) return false;
  return proof.kind === "MCP_INSPECTOR_E2E"
    && proof.inspectorPackage === "@modelcontextprotocol/inspector"
    && typeof proof.inspectorVersion === "string"
    && /^\d+\.\d+\.\d+$/u.test(proof.inspectorVersion)
    && httpEndpoint(proof.endpoint)
    && proof.initializePassed === true
    && proof.toolCount === 27
    && proof.readPassed === true
    && proof.mutationPassed === true
    && proof.insufficientScopePassed === true;
}

function validateWindowsNativeProof(proof, context) {
  if (!exactObject(proof, [
    "kind", "toolSpanVersion", "msiSha256", "nsisSha256", "installSmokePassed",
    "traySmokePassed", "ownedProcessSmokePassed", "unrelatedProcessSurvived",
  ]) || context === null || typeof context !== "object") return false;
  return proof.kind === "WINDOWS_NATIVE_SMOKE"
    && typeof proof.toolSpanVersion === "string"
    && proof.toolSpanVersion === context.toolSpanVersion
    && sha256(proof.msiSha256)
    && proof.msiSha256 === context.msiSha256
    && sha256(proof.nsisSha256)
    && proof.nsisSha256 === context.nsisSha256
    && proof.installSmokePassed === true
    && proof.traySmokePassed === true
    && proof.ownedProcessSmokePassed === true
    && proof.unrelatedProcessSurvived === true;
}

function validateCloudflareLifecycleProof(proof, gateId) {
  if (!exactObject(proof, [
    "kind", "credentialType", "zoneName", "zoneId", "accountId", "planHash",
    "applyStatus", "secondRunDuplicateCreates", "publicEndpoint", "publicHealthPassed",
    "oauthDiscoveryPassed", "publicToolCount", "ownedCleanupPassed",
  ])) return false;
  const expectedCredentialType = "SCOPED_API_TOKEN";
  let endpoint;
  try {
    endpoint = new URL(proof.publicEndpoint);
  } catch {
    return false;
  }
  const hostname = endpoint.hostname.toLowerCase();
  return proof.kind === "CLOUDFLARE_LIFECYCLE"
    && proof.credentialType === expectedCredentialType
    && proof.zoneName === "aiqushi.top"
    && cloudflareId(proof.zoneId)
    && cloudflareId(proof.accountId)
    && sha256(proof.planHash)
    && proof.applyStatus === "APPLIED"
    && proof.secondRunDuplicateCreates === 0
    && endpoint.protocol === "https:"
    && endpoint.username === ""
    && endpoint.password === ""
    && (hostname === "aiqushi.top" || hostname.endsWith(".aiqushi.top"))
    && proof.publicHealthPassed === true
    && proof.oauthDiscoveryPassed === true
    && proof.publicToolCount === 27
    && proof.ownedCleanupPassed === true;
}

function matchesCurrentNativeArtifacts(proof, context) {
  return context !== null
    && typeof context === "object"
    && proof.toolSpanVersion === context.toolSpanVersion
    && sha256(proof.msiSha256)
    && proof.msiSha256 === context.msiSha256
    && sha256(proof.nsisSha256)
    && proof.nsisSha256 === context.nsisSha256;
}

function validateOwnerProof(proof) {
  return exactObject(proof, [
    "kind", "publicationApproved", "ipRightsConfirmed", "trademarkConfirmed", "licenseApproved",
  ])
    && proof.kind === "OWNER_PUBLICATION_APPROVAL"
    && proof.publicationApproved === true
    && proof.ipRightsConfirmed === true
    && proof.trademarkConfirmed === true
    && proof.licenseApproved === true;
}

function validateGitHubProof(proof) {
  if (!exactObject(proof, [
    "kind", "repositoryUrl", "securityPolicyConfigured", "rulesetConfigured",
    "defaultBranchProtected", "privateVulnerabilityReportingEnabled",
  ])) return false;
  let repository;
  try {
    repository = new URL(proof.repositoryUrl);
  } catch {
    return false;
  }
  return proof.kind === "GITHUB_RELEASE_SETTINGS"
    && repository.protocol === "https:"
    && repository.hostname.toLowerCase() === "github.com"
    && repository.username === ""
    && repository.password === ""
    && repository.pathname.split("/").filter(Boolean).length === 2
    && proof.securityPolicyConfigured === true
    && proof.rulesetConfigured === true
    && proof.defaultBranchProtected === true
    && proof.privateVulnerabilityReportingEnabled === true;
}

function validateSigningProof(proof, context) {
  return exactObject(proof, [
    "kind", "toolSpanVersion", "msiSha256", "nsisSha256", "msiSignatureValid",
    "nsisSignatureValid", "certificateThumbprintSha256", "timestamped",
  ])
    && proof.kind === "WINDOWS_AUTHENTICODE"
    && matchesCurrentNativeArtifacts(proof, context)
    && proof.msiSignatureValid === true
    && proof.nsisSignatureValid === true
    && sha256(proof.certificateThumbprintSha256)
    && proof.timestamped === true;
}

function validateCloudflaredWindowsProof(proof, context) {
  return exactObject(proof, [
    "kind", "toolSpanVersion", "msiSha256", "nsisSha256", "installPassed", "startPassed",
    "rebootPersistencePassed", "uninstallPassed", "unrelatedServicePreserved",
  ])
    && proof.kind === "CLOUDFLARED_WINDOWS_SERVICE"
    && matchesCurrentNativeArtifacts(proof, context)
    && proof.installPassed === true
    && proof.startPassed === true
    && proof.rebootPersistencePassed === true
    && proof.uninstallPassed === true
    && proof.unrelatedServicePreserved === true;
}

function validateChatGptProof(proof) {
  return exactObject(proof, [
    "kind", "accountConfirmed", "endpoint", "developerModeVisible", "customMcpUiReachable",
    "oauthDiscoveryPassed", "toolScanPassed", "toolCount", "readInvocationPassed",
    "businessWorkspaceUsed",
  ])
    && proof.kind === "CHATGPT_UI_SMOKE"
    && proof.accountConfirmed === true
    && remoteHttpsUrl(proof.endpoint)
    && proof.developerModeVisible === true
    && proof.customMcpUiReachable === true
    && proof.oauthDiscoveryPassed === true
    && proof.toolScanPassed === true
    && proof.toolCount === 27
    && proof.readInvocationPassed === true
    && proof.businessWorkspaceUsed === false;
}

function validateOauthSoakProof(proof) {
  return exactObject(proof, [
    "kind", "durationMinutes", "refreshObserved", "rotationObserved", "scopePreserved",
    "reconnectPassed",
  ])
    && proof.kind === "OAUTH_SOAK"
    && Number.isInteger(proof.durationMinutes)
    && proof.durationMinutes >= 60
    && proof.refreshObserved === true
    && proof.rotationObserved === true
    && proof.scopePreserved === true
    && proof.reconnectPassed === true;
}

function validateAffiliateProof(proof, context) {
  if (!exactObject(proof, [
    "kind", "snapshotSha256", "officialSourceUrl", "affiliateLinkCurrent", "couponCurrent",
    "offerCurrent",
  ]) || context === null || typeof context !== "object") return false;
  let source;
  try {
    source = new URL(proof.officialSourceUrl);
  } catch {
    return false;
  }
  return proof.kind === "AFFILIATE_CURRENTNESS"
    && sha256(proof.snapshotSha256)
    && proof.snapshotSha256 === context.affiliateSnapshotSha256
    && source.protocol === "https:"
    && source.hostname.toLowerCase() === "www.namesilo.com"
    && source.username === ""
    && source.password === ""
    && proof.affiliateLinkCurrent === true
    && proof.couponCurrent === true
    && proof.offerCurrent === true;
}

function validateAssetProof(proof) {
  return exactObject(proof, [
    "kind", "provider", "rightsConfirmed", "provenanceConfirmed", "assetSha256s",
  ])
    && proof.kind === "VENDOR_ASSET_RIGHTS"
    && proof.provider === "namesilo"
    && proof.rightsConfirmed === true
    && proof.provenanceConfirmed === true
    && Array.isArray(proof.assetSha256s)
    && proof.assetSha256s.length > 0
    && proof.assetSha256s.every(sha256)
    && new Set(proof.assetSha256s).size === proof.assetSha256s.length;
}

function validateOpenAiDataProof(proof, context) {
  return exactObject(proof, [
    "kind", "snapshotSha256", "officialSourceCount", "numericClaimsCurrent", "mcpPlanClaimsCurrent",
  ])
    && context !== null
    && typeof context === "object"
    && proof.kind === "OPENAI_QUOTA_CURRENTNESS"
    && sha256(proof.snapshotSha256)
    && proof.snapshotSha256 === context.openAiSnapshotSha256
    && Number.isInteger(proof.officialSourceCount)
    && proof.officialSourceCount > 0
    && proof.numericClaimsCurrent === true
    && proof.mcpPlanClaimsCurrent === true;
}

function validateGateProof(gate, proof, options) {
  switch (gate.id) {
    case "E-OWNER-01": return validateOwnerProof(proof);
    case "E-GH-01": return validateGitHubProof(proof);
    case "E-WIN-01": return validateWindowsNativeProof(proof, options.currentReleaseContext);
    case "E-SIGN-01": return validateSigningProof(proof, options.currentReleaseContext);
    case "E-CF-TOKEN-01": return validateCloudflareLifecycleProof(proof, gate.id);
    case "E-CF-WIN-01": return validateCloudflaredWindowsProof(proof, options.currentReleaseContext);
    case "E-HOST-01": return validateInspectorProof(proof);
    case "E-CODEX-01": return validateCodexProof(proof);
    case "E-CGPT-UI-01": return validateChatGptProof(proof);
    case "E-OAUTH-SOAK-01": return validateOauthSoakProof(proof);
    case "E-AFF-01": return validateAffiliateProof(proof, options.currentReleaseContext);
    case "E-ASSET-01": return validateAssetProof(proof);
    case "E-DATA-01": return validateOpenAiDataProof(proof, options.currentReleaseContext);
    default: return false;
  }
}

export function validateManualGateEvidence(document, gate, options = {}) {
  if (document === null || typeof document !== "object" || Array.isArray(document)) return false;
  const keys = Object.keys(document).sort();
  const expected = [
    "observedAt", "requirementId", "sanitized", "schemaVersion", "secretValues", "status",
    ...(document.status === "PASS" ? ["proof"] : []),
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
  return document.schemaVersion === "1.0"
    && document.requirementId === gate.id
    && gate.allowed.includes(document.status)
    && observedAtIsCurrent(document.observedAt, gate, options.now ?? new Date())
    && document.sanitized === true
    && document.secretValues === 0
    && (document.status !== "PASS" || validateGateProof(gate, document.proof, options));
}

async function statusFromManualEvidence(gate, options = {}) {
  const evidencePath = path.join(options.externalEvidenceRoot ?? externalEvidenceRoot, `${gate.id}.json`);
  try {
    const document = JSON.parse(await (options.readFile ?? readFile)(evidencePath, "utf8"));
    const valid = validateManualGateEvidence(document, gate, options);
    return {
      status: valid ? document.status : gate.fallback,
      proofValidated: valid && document.status === "PASS",
    };
  } catch {
    return { status: gate.fallback, proofValidated: false };
  }
}

export async function evaluateReleaseGates(options = {}) {
  const gates = [];
  for (const gate of RELEASE_GATE_MATRIX) {
    const evidence = await statusFromManualEvidence(gate, options);
    let { status, proofValidated } = evidence;
    if (gate.id === "E-OWNER-01") {
      const licenseText = options.licenseText
        ?? await (options.readFile ?? readFile)(path.join(projectRoot, "LICENSE"), "utf8");
      if (/OWNER GATE|No open-source license has been selected|BLOCKED_BY_OWNER_INPUT/iu.test(licenseText)) {
        status = "EXTERNAL_GATE_PENDING";
        proofValidated = false;
      }
    }
    gates.push({ id: gate.id, required: gate.required, status, proofValidated });
  }
  return gates;
}

export function countExternalGatesPromotedWithoutEvidence(gates) {
  return gates.filter((gate) => gate.status === "PASS" && gate.proofValidated !== true).length;
}

export function summarizeReleaseReadiness(gates, claimPolicy = RELEASE_CLAIM_POLICY) {
  const requiredPending = gates.filter((gate) => gate.required === true && gate.status !== "PASS").map((gate) => gate.id);
  const conditionalPending = gates.filter((gate) => typeof gate.required === "string" && gate.status !== "PASS")
    .map((gate) => {
      const policy = claimPolicy[gate.required];
      return {
        id: gate.id,
        condition: gate.required,
        status: gate.status,
        active: policy?.active !== false,
        basis: policy?.basis ?? "UNDECLARED_CLAIM_CONSERVATIVELY_ACTIVE",
      };
    });
  const activeConditionalPending = conditionalPending.filter((gate) => gate.active);
  const inactiveConditionalFallbacks = conditionalPending.filter((gate) => !gate.active);
  return {
    releaseReady: requiredPending.length === 0 && activeConditionalPending.length === 0,
    requiredPending,
    conditionalPending,
    activeConditionalPending,
    inactiveConditionalFallbacks,
  };
}

async function runRootScript(npmCli, script, label, environment) {
  await npmCommand(["run", script], { npmCli, label, environment });
}

function safeReportName(now) {
  return `release-verification-${now.toISOString().replace(/[-:.]/gu, "")}.json`;
}

export function validateLatestDryRunPointer(value) {
  return exactObject(value, [
    "schemaVersion", "status", "scope", "dryRunOnly", "runDirectory", "report",
  ])
    && value.schemaVersion === "1.0"
    && value.status === "PASS"
    && value.scope === "RELEASE_DRY_RUN_ASSEMBLY"
    && value.dryRunOnly === true
    && typeof value.runDirectory === "string"
    && /^run-[A-Za-z0-9-]+$/u.test(value.runDirectory)
    && value.report === `${value.runDirectory}/artifact-manifest.json`;
}

export async function verifyRelease(options = {}) {
  const environment = verificationEnvironment(options.environment ?? process.env);
  const npmCli = options.npmCli ?? await resolveNpmCli(environment);
  if (npmCli === null) return { status: "BLOCKED_BY_ENVIRONMENT", reason: "NPM_CLI_NOT_FOUND", exitCode: 2 };
  const runRoot = options.runRoot ?? ((script, label) => runRootScript(npmCli, script, label, environment));
  const evidenceRoot = options.releaseEvidenceRoot ?? releaseEvidenceRoot;
  const fileReader = options.readFile ?? readFile;
  const fileWriter = options.writeFile ?? writeFile;
  const makeDirectory = options.mkdir ?? mkdir;
  try {
    await runRoot("check:test-environment", "External test-environment v2 policy");
    await runRoot("verify:all:source", "All deterministic source stages");
    await runRoot("release:dry-run", "Release assembly dry run");
  } catch (error) {
    if (error?.exitCode === 2 || ["NPM_CLI_NOT_FOUND", "MSVC_BUILD_TOOLS_NOT_DETECTED", "ENOENT"].includes(error?.code)) {
      return {
        status: "BLOCKED_BY_ENVIRONMENT",
        reason: "RELEASE_AUTOMATED_GATE_ENVIRONMENT_BLOCKED",
        failedStep: error instanceof Error ? error.message : "unknown step",
        releaseReady: false,
        exitCode: 2,
      };
    }
    return {
      status: "FAIL",
      classification: "REGRESSION",
      reason: "RELEASE_AUTOMATED_GATE_FAILED",
      failedStep: error instanceof Error ? error.message : "unknown step",
      releaseReady: false,
      exitCode: 1,
    };
  }

  const latestPath = path.join(evidenceRoot, "latest.json");
  if (!await (options.isFile ?? isFile)(latestPath)) {
    return { status: "FAIL", reason: "RELEASE_DRY_RUN_EVIDENCE_MISSING", releaseReady: false, exitCode: 1 };
  }
  const latest = JSON.parse(await fileReader(latestPath, "utf8"));
  if (!validateLatestDryRunPointer(latest)) {
    return { status: "FAIL", reason: "RELEASE_DRY_RUN_EVIDENCE_INVALID", releaseReady: false, exitCode: 1 };
  }
  const manifestPath = path.join(evidenceRoot, latest.runDirectory, "artifact-manifest.json");
  const desktopManifestPath = path.join(evidenceRoot, latest.runDirectory, "desktop-bundles.manifest.json");
  const [manifest, desktopManifest, affiliateSnapshot, openAiSnapshot] = await Promise.all([
    fileReader(manifestPath, "utf8").then(JSON.parse),
    fileReader(desktopManifestPath, "utf8").then(JSON.parse),
    fileReader(path.join(projectRoot, "config", "namesilo-offer.snapshot.json")),
    fileReader(path.join(projectRoot, "config", "openai-plan-usage.snapshot.json")),
  ]);
  if (manifest?.status !== "PASS" || manifest?.dryRunOnly !== true
    || manifest?.tagCreated !== false || manifest?.published !== false) {
    return { status: "FAIL", reason: "RELEASE_DRY_RUN_CLAIM_INVALID", releaseReady: false, exitCode: 1 };
  }
  const currentReleaseContext = currentReleaseContextFromManifests(manifest, desktopManifest, {
    affiliate: affiliateSnapshot,
    openAi: openAiSnapshot,
  });
  if (currentReleaseContext === null) {
    return { status: "FAIL", reason: "RELEASE_DRY_RUN_NATIVE_CONTEXT_INVALID", releaseReady: false, exitCode: 1 };
  }

  const now = options.now ?? new Date();
  const gates = await evaluateReleaseGates({
    ...options,
    readFile: fileReader,
    now,
    currentReleaseContext,
  });
  const claimPolicy = options.claimPolicy ?? claimPolicyFromOpenAiSnapshot(openAiSnapshot);
  const readiness = summarizeReleaseReadiness(gates, claimPolicy);
  const externalGatesPromotedWithoutEvidence = countExternalGatesPromotedWithoutEvidence(gates);
  const releaseReady = readiness.releaseReady && externalGatesPromotedWithoutEvidence === 0;
  const report = {
    schemaVersion: "1.0",
    generatedAt: now.toISOString(),
    status: releaseReady ? "PASS" : "EXTERNAL_GATE_PENDING",
    releaseReady,
    deterministicGates: {
      testEnvironmentV2: "PASS",
      allSource: "PASS",
      releaseDryRun: "PASS",
      tagCreated: false,
      published: false,
    },
    gateMatrix: gates,
    claimPolicy,
    requiredPending: readiness.requiredPending,
    conditionalPending: readiness.conditionalPending,
    activeConditionalPending: readiness.activeConditionalPending,
    inactiveConditionalFallbacks: readiness.inactiveConditionalFallbacks,
    externalGatesPromotedWithoutEvidence,
    dryRunEvidence: `${latest.runDirectory}/artifact-manifest.json`,
  };
  await makeDirectory(evidenceRoot, { recursive: true });
  const reportName = safeReportName(now);
  await fileWriter(path.join(evidenceRoot, reportName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fileWriter(path.join(evidenceRoot, "latest-verification.json"), `${JSON.stringify({
    schemaVersion: "1.0",
    status: report.status,
    releaseReady: report.releaseReady,
    report: reportName,
  }, null, 2)}\n`, "utf8");
  return {
    status: report.status,
    releaseReady: report.releaseReady,
    deterministicGates: "PASS",
    requiredPending: readiness.requiredPending,
    conditionalPending: readiness.conditionalPending.map((entry) => entry.id),
    activeConditionalPending: readiness.activeConditionalPending.map((entry) => entry.id),
    inactiveConditionalFallbacks: readiness.inactiveConditionalFallbacks.map((entry) => entry.id),
    externalGatesPromotedWithoutEvidence,
    tagCreated: false,
    published: false,
    evidence: `.toolspan-dev/evidence/release/${reportName}`,
    exitCode: releaseReady ? 0 : 3,
  };
}

async function main() {
  try {
    const result = await verifyRelease();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode;
  } catch {
    process.stdout.write(`${JSON.stringify({
      status: "FAIL",
      reason: "RELEASE_VERIFICATION_CRASHED",
      releaseReady: false,
      tagCreated: false,
      published: false,
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
