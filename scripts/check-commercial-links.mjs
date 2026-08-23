import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULTS = {
  links: path.join(ROOT, "config", "commercial-links.json"),
  offer: path.join(ROOT, "config", "namesilo-offer.snapshot.json"),
  chatgpt: path.join(ROOT, "config", "chatgpt-mcp-guide.snapshot.json"),
  cloudflare: path.join(ROOT, "config", "cloudflare-api-docs.snapshot.json"),
};

function fail(message) {
  throw new Error(`commercial links check: ${message}`);
}

function record(value, location) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${location} must be an object`);
  return value;
}

function exactKeys(value, expected, location) {
  const actual = Object.keys(record(value, location)).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${location} keys must be exactly: ${wanted.join(", ")}`);
  }
}

function string(value, location) {
  if (typeof value !== "string" || value.length === 0) fail(`${location} must be a non-empty string`);
  return value;
}

function boolean(value, location) {
  if (typeof value !== "boolean") fail(`${location} must be a boolean`);
  return value;
}

function utcDate(value, location) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) fail(`${location} must use YYYY-MM-DD`);
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value) {
    fail(`${location} is not a valid calendar date`);
  }
  return milliseconds;
}

function finiteNonNegative(value, location) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(`${location} must be a finite non-negative number`);
  return value;
}

function httpsUrl(value, location, allowedHost) {
  let parsed;
  try {
    parsed = new URL(string(value, location));
  } catch {
    fail(`${location} must be an absolute URL`);
  }
  if (parsed.protocol !== "https:") fail(`${location} must use HTTPS`);
  if (parsed.username !== "" || parsed.password !== "") fail(`${location} must not contain userinfo`);
  if (parsed.port !== "" || parsed.hash !== "") fail(`${location} must not contain a custom port or fragment`);
  if (allowedHost !== undefined && parsed.hostname !== allowedHost) fail(`${location} must use ${allowedHost}`);
  return parsed;
}

async function json(filePath, location) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    fail(`cannot read ${location}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  try {
    return JSON.parse(source);
  } catch {
    fail(`${location} is not valid JSON`);
  }
}

export function validateCommercialLinks(value) {
  exactKeys(value, ["schemaVersion", "provider", "affiliateId", "coupon", "links"], "commercialLinks");
  if (value.schemaVersion !== 1 || value.provider !== "namesilo") fail("commercialLinks identity/version is invalid");
  if (value.affiliateId !== "1373371gm") fail("commercialLinks.affiliateId must match the owner-provided initial input");
  if (value.coupon !== "toolspan") fail("commercialLinks.coupon must match the owner-provided initial input");
  exactKeys(value.links, ["home", "search", "pricing"], "commercialLinks.links");

  const expectedPaths = { home: "/", search: "/domain/search-domains", pricing: "/pricing" };
  for (const [name, expectedPath] of Object.entries(expectedPaths)) {
    const link = value.links[name];
    exactKeys(link, ["direct"], `commercialLinks.links.${name}`);
    const direct = httpsUrl(link.direct, `commercialLinks.links.${name}.direct`, "www.namesilo.com");
    if (direct.pathname !== expectedPath) {
      fail(`commercialLinks.links.${name} must preserve the expected NameSilo path`);
    }
    if (direct.search !== "" || direct.searchParams.has("rid")) {
      fail(`commercialLinks.links.${name}.direct must contain no query or referral attribution`);
    }
  }
  return value;
}

export function validateOfferSnapshot(value, links) {
  exactKeys(value, [
    "schemaVersion", "provider", "verifiedAt", "verificationStatus", "verificationGaps",
    "exampleTld", "firstYearRegistrationUsd",
    "affiliateCouponCode", "affiliateCouponDiscountUsd", "illustrativeEligibleTotalUsd",
    "conditional", "staleAfterDays", "source", "notes",
  ], "offerSnapshot");
  if (value.schemaVersion !== 2 || value.provider !== "namesilo") fail("offerSnapshot identity/version is invalid");
  utcDate(value.verifiedAt, "offerSnapshot.verifiedAt");
  if (!new Set(["OFFICIAL_SOURCES_VERIFIED", "INCOMPLETE_OFFICIAL_COVERAGE"]).has(value.verificationStatus)) {
    fail("offerSnapshot.verificationStatus is invalid");
  }
  if (!Array.isArray(value.verificationGaps)
    || new Set(value.verificationGaps).size !== value.verificationGaps.length
    || value.verificationGaps.some((gap) => typeof gap !== "string" || !/^[A-Z0-9_]+$/u.test(gap))) {
    fail("offerSnapshot.verificationGaps must be unique stable codes");
  }
  if (value.verificationStatus === "OFFICIAL_SOURCES_VERIFIED" && value.verificationGaps.length !== 0) {
    fail("a fully verified offer cannot retain verification gaps");
  }
  if (value.verificationStatus === "INCOMPLETE_OFFICIAL_COVERAGE" && value.verificationGaps.length === 0) {
    fail("incomplete offer coverage requires at least one verification gap");
  }
  if (value.exampleTld !== "top") fail("offerSnapshot.exampleTld must be the owner-provided .top example");
  const firstYear = finiteNonNegative(value.firstYearRegistrationUsd, "offerSnapshot.firstYearRegistrationUsd");
  const discount = finiteNonNegative(value.affiliateCouponDiscountUsd, "offerSnapshot.affiliateCouponDiscountUsd");
  const total = finiteNonNegative(value.illustrativeEligibleTotalUsd, "offerSnapshot.illustrativeEligibleTotalUsd");
  if (Math.round((firstYear - discount) * 100) !== Math.round(total * 100)) {
    fail("offerSnapshot illustrative total must equal first-year example minus conditional discount");
  }
  if (value.affiliateCouponCode !== links.coupon) fail("offerSnapshot coupon must match commercialLinks.coupon");
  if (value.conditional !== true || value.staleAfterDays !== 30) fail("offerSnapshot must remain conditional with a 30-day stale threshold");
  const source = httpsUrl(value.source, "offerSnapshot.source", "www.namesilo.com");
  if (source.pathname !== "/pricing" || source.search !== "") fail("offerSnapshot.source must be the direct NameSilo pricing page");
  if (!Array.isArray(value.notes) || value.notes.length < 3 || value.notes.some((note) => typeof note !== "string" || note.length === 0)) {
    fail("offerSnapshot.notes must contain at least three non-empty qualifications");
  }
  const notes = value.notes.join(" ");
  for (const qualifier of [/renew/iu, /eligib|premium/iu, /Discount Program/iu]) {
    if (!qualifier.test(notes)) fail("offerSnapshot.notes must cover renewal, eligibility/premium, and Discount Program conflicts");
  }
  return value;
}

export function datedFreshness(verifiedAt, staleAfterDays, now = new Date(), staleStatus = "STALE_FALLBACK") {
  const verifiedAtMs = utcDate(verifiedAt, "snapshot.verifiedAt");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail("now must be a valid Date");
  if (!Number.isInteger(staleAfterDays) || staleAfterDays !== 30) fail("snapshot staleAfterDays must be exactly 30");
  const ageMs = now.getTime() - verifiedAtMs;
  if (ageMs < -DAY_MS) fail("snapshot.verifiedAt cannot be more than one day in the future");
  const ageDays = Math.max(0, Math.floor(ageMs / DAY_MS));
  return {
    status: ageDays > staleAfterDays ? staleStatus : "CURRENT",
    ageDays,
    staleAfterDays,
  };
}

export function offerPresentation(snapshot, now = new Date()) {
  const freshness = datedFreshness(snapshot.verifiedAt, snapshot.staleAfterDays, now, "STALE_FALLBACK");
  const incompleteCoverage = snapshot.verificationStatus !== "OFFICIAL_SOURCES_VERIFIED";
  if (freshness.status === "STALE_FALLBACK" || incompleteCoverage) {
    return {
      ...freshness,
      status: "STALE_FALLBACK",
      fallbackReason: incompleteCoverage
        ? "OFFICIAL_SOURCE_COVERAGE_INCOMPLETE"
        : "SNAPSHOT_OLDER_THAN_30_DAYS",
      offerNumbersVisible: false,
      couponCtaVisible: false,
      firstYearRegistrationUsd: null,
      affiliateCouponDiscountUsd: null,
      illustrativeEligibleTotalUsd: null,
      affiliateCouponCode: null,
      fallback: "SEE_CURRENT_CHECKOUT",
    };
  }
  return {
    ...freshness,
    fallbackReason: null,
    offerNumbersVisible: true,
    couponCtaVisible: true,
    firstYearRegistrationUsd: snapshot.firstYearRegistrationUsd,
    affiliateCouponDiscountUsd: snapshot.affiliateCouponDiscountUsd,
    illustrativeEligibleTotalUsd: snapshot.illustrativeEligibleTotalUsd,
    affiliateCouponCode: snapshot.affiliateCouponCode,
    fallback: null,
  };
}

export function validateChatgptSnapshot(value) {
  exactKeys(value, [
    "schemaVersion", "verifiedAt", "staleAfterDays", "verificationStatus", "source", "productLabel",
    "developerModePath", "connectionPage", "publicMcpPath", "expectedToolCount",
    "availabilityDependsOnAccountOrWorkspacePolicy", "businessWorkspaceRequired",
    "writeValidationRequiredInChatGpt", "truthfulStatuses", "fallbackText",
  ], "chatgptSnapshot");
  if (value.schemaVersion !== 1 || value.staleAfterDays !== 30 || value.verificationStatus !== "OFFICIAL_DOCS_VERIFIED") {
    fail("chatgptSnapshot version/freshness/verification descriptor is invalid");
  }
  utcDate(value.verifiedAt, "chatgptSnapshot.verifiedAt");
  const source = httpsUrl(value.source, "chatgptSnapshot.source", "developers.openai.com");
  if (source.pathname !== "/plugins/deploy/connect-chatgpt") fail("chatgptSnapshot.source must be the official connect/test guide");
  httpsUrl(value.connectionPage, "chatgptSnapshot.connectionPage", "chatgpt.com");
  if (!Array.isArray(value.developerModePath) || value.developerModePath.length < 3 || value.developerModePath.some((item) => typeof item !== "string" || item.length === 0)) {
    fail("chatgptSnapshot.developerModePath must be a non-empty path");
  }
  if (value.publicMcpPath !== "/mcp" || value.expectedToolCount !== 27) fail("chatgptSnapshot must preserve /mcp and exact 27 tools");
  if (value.availabilityDependsOnAccountOrWorkspacePolicy !== true || value.businessWorkspaceRequired !== false || value.writeValidationRequiredInChatGpt !== false) {
    fail("chatgptSnapshot must preserve truthful account-policy and no-Business/write-gate assumptions");
  }
  const expectedStatuses = ["MANUAL_PENDING", "USER_CONFIRMED", "VALIDATED", "BLOCKED_BY_HOST_PLAN_OR_POLICY"];
  if (!Array.isArray(value.truthfulStatuses) || JSON.stringify(value.truthfulStatuses) !== JSON.stringify(expectedStatuses)) {
    fail("chatgptSnapshot.truthfulStatuses is invalid");
  }
  string(value.productLabel, "chatgptSnapshot.productLabel");
  string(value.fallbackText, "chatgptSnapshot.fallbackText");
  return value;
}

export function validateCloudflareSnapshot(value) {
  exactKeys(value, [
    "schemaVersion", "verifiedAt", "staleAfterDays", "verificationStatus", "apiOrigin", "apiBase",
    "officialDocs", "permissionsAtVerification", "permissionLabelsAreReleaseAssertion", "zoneApplyGate",
    "authModes", "runtimeCredentialHolder", "fallbackText",
  ], "cloudflareSnapshot");
  if (value.schemaVersion !== 1 || value.staleAfterDays !== 30 || value.verificationStatus !== "OFFICIAL_DOCS_VERIFIED") {
    fail("cloudflareSnapshot version/freshness/verification descriptor is invalid");
  }
  utcDate(value.verifiedAt, "cloudflareSnapshot.verifiedAt");
  if (value.apiOrigin !== "https://api.cloudflare.com" || value.apiBase !== "https://api.cloudflare.com/client/v4") {
    fail("cloudflareSnapshot must freeze the allowed Cloudflare API origin/base");
  }
  exactKeys(value.officialDocs, ["tokenPermissions", "zoneStatus", "tunnelCreate", "dnsRecords"], "cloudflareSnapshot.officialDocs");
  for (const [name, url] of Object.entries(value.officialDocs)) httpsUrl(url, `cloudflareSnapshot.officialDocs.${name}`, "developers.cloudflare.com");
  if (!Array.isArray(value.permissionsAtVerification) || value.permissionsAtVerification.length < 3) fail("cloudflareSnapshot must record dated permission labels");
  for (const [index, permission] of value.permissionsAtVerification.entries()) {
    exactKeys(permission, ["scope", "name"], `cloudflareSnapshot.permissionsAtVerification[${index}]`);
    if (!new Set(["account", "zone"]).has(permission.scope)) fail("cloudflareSnapshot permission scope is invalid");
    string(permission.name, `cloudflareSnapshot.permissionsAtVerification[${index}].name`);
  }
  if (value.permissionLabelsAreReleaseAssertion !== false) fail("dated permission labels cannot be a Release currentness assertion");
  exactKeys(value.zoneApplyGate, ["requiredStatus", "missingResult", "pendingResult"], "cloudflareSnapshot.zoneApplyGate");
  if (value.zoneApplyGate.requiredStatus !== "active" || value.zoneApplyGate.missingResult !== "STOP_APPLY" || value.zoneApplyGate.pendingResult !== "STOP_APPLY") {
    fail("cloudflareSnapshot Zone gate must stop missing/pending and require active");
  }
  exactKeys(value.authModes, ["scopedApiToken"], "cloudflareSnapshot.authModes");
  exactKeys(value.authModes.scopedApiToken, ["recommended", "headerNames", "persistSecretValue"], "cloudflareSnapshot.authModes.scopedApiToken");
  if (value.authModes.scopedApiToken.recommended !== true || value.authModes.scopedApiToken.persistSecretValue !== false) fail("scoped Token mode boundary is invalid");
  if (value.runtimeCredentialHolder !== "cloudflared-official-mechanism") fail("runtime credential holder boundary is invalid");
  string(value.fallbackText, "cloudflareSnapshot.fallbackText");
  return value;
}

function guidePresentation(snapshot, now, staleStatus, visibleKey) {
  const freshness = datedFreshness(snapshot.verifiedAt, snapshot.staleAfterDays, now, staleStatus);
  return { ...freshness, [visibleKey]: freshness.status === "CURRENT" };
}

function parseArguments(arguments_) {
  const options = { ...DEFAULTS, now: new Date() };
  for (const argument of arguments_) {
    if (argument.startsWith("--now=")) options.now = new Date(`${argument.slice(6)}T00:00:00.000Z`);
    else if (argument.startsWith("--links=")) options.links = path.resolve(argument.slice(8));
    else if (argument.startsWith("--offer=")) options.offer = path.resolve(argument.slice(8));
    else if (argument.startsWith("--chatgpt=")) options.chatgpt = path.resolve(argument.slice(10));
    else if (argument.startsWith("--cloudflare=")) options.cloudflare = path.resolve(argument.slice(13));
    else fail(`unknown argument: ${argument}`);
  }
  if (Number.isNaN(options.now.getTime())) fail("--now must be a valid YYYY-MM-DD date");
  return options;
}

export async function run(arguments_ = process.argv.slice(2)) {
  const options = parseArguments(arguments_);
  const [linksValue, offerValue, chatgptValue, cloudflareValue] = await Promise.all([
    json(options.links, "commercial links"),
    json(options.offer, "NameSilo offer snapshot"),
    json(options.chatgpt, "ChatGPT MCP guide snapshot"),
    json(options.cloudflare, "Cloudflare API docs snapshot"),
  ]);
  const links = validateCommercialLinks(linksValue);
  const offer = validateOfferSnapshot(offerValue, links);
  const chatgpt = validateChatgptSnapshot(chatgptValue);
  const cloudflare = validateCloudflareSnapshot(cloudflareValue);
  const offerView = offerPresentation(offer, options.now);
  const chatgptView = guidePresentation(chatgpt, options.now, "STALE_GUIDE_FALLBACK", "uiPathVisible");
  const cloudflareView = guidePresentation(cloudflare, options.now, "STALE_DOCS_FALLBACK", "permissionLabelsVisible");
  const result = {
    status: "PASS",
    referralPairs: 3,
    directLinksWithoutRid: 3,
    offer: offerView,
    chatgptGuide: chatgptView,
    cloudflareDocs: cloudflareView,
    permissionLabelsAreReleaseAssertion: false,
    networkRequests: 0,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "commercial links check failed"}\n`);
    process.exitCode = 1;
  });
}
