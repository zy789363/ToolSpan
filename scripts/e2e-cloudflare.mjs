import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { analyzeTestEnvironment } from "./check-test-environment.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST_PATH = path.join(PROJECT_ROOT, ".toolspan-dev", "test-environment.json");
const DEFAULT_MANIFEST_SCHEMA_PATH = path.join(PROJECT_ROOT, "schemas", "test-environment.schema.json");
const DEFAULT_EVIDENCE_SCHEMA_PATH = path.join(PROJECT_ROOT, "schemas", "cloudflare-e2e-evidence.schema.json");
const DEFAULT_EVIDENCE_DIRECTORY = path.join(PROJECT_ROOT, ".toolspan-dev", "evidence");
const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com";
const API_PREFIX = "/client/v4";
const FIXED_ZONE = "aiqushi.top";
const FIXED_HOSTNAME = "mcp.aiqushi.top";
const TUNNEL_PREFIX = "toolspan-e2e-";
const LOCAL_SERVICE = "http://127.0.0.1:8787";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PAGES = 20;

const TERMINAL_STATUSES = new Set([
  "PASS",
  "FAIL",
  "BLOCKED_BY_ENVIRONMENT",
  "BLOCKED_BY_EXTERNAL_ACCOUNT",
  "NEEDS_HUMAN_CHECKPOINT",
]);

const ALLOWED_EVIDENCE_SECRET_LIKE_FIELDS = new Set([
  "credentialType",
  "credentialVerified",
  "secretScan",
  "matchedSecretValues",
  "forbiddenFieldCount",
]);

class RunnerFault extends Error {
  constructor(code, classification = "FAIL", details = {}) {
    super(code);
    this.name = "RunnerFault";
    this.code = code;
    this.classification = classification;
    this.httpStatus = details.httpStatus;
    this.cloudflareErrorCodes = details.cloudflareErrorCodes ?? [];
    this.outcomeUnknown = details.outcomeUnknown === true;
  }
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isoNow(clock) {
  return clock().toISOString();
}

function sessionId(clock, bytes) {
  const date = isoNow(clock).slice(0, 10).replaceAll("-", "");
  return `${date}-${bytes(5).toString("hex")}`;
}

function checkedSessionId(value) {
  if (typeof value !== "string" || !/^[0-9]{8}-[a-f0-9]{10}$/u.test(value)) {
    throw new RunnerFault("SESSION_ID_INVALID");
  }
  return value;
}

function makeBaseEvidence({ clock, id, mode, credentialType }) {
  return {
    schemaVersion: "2.0",
    evidenceType: "TOOLSPAN_CLOUDFLARE_API_E2E",
    generatedAt: isoNow(clock),
    sessionId: id,
    scopeClaim: "API_RESOURCE_LIFECYCLE_ONLY",
    mode,
    readOnly: mode !== "APPLY",
    target: {
      zoneName: FIXED_ZONE,
      preferredHostname: FIXED_HOSTNAME,
      hostname: FIXED_HOSTNAME,
      hostnameSelection: "PREFERRED",
      tunnelPrefix: TUNNEL_PREFIX,
      localService: LOCAL_SERVICE,
    },
    status: "NEEDS_HUMAN_CHECKPOINT",
    decision: "STOP",
    reason: "RUNNING",
    credentialType,
    credentialVerified: false,
    zone: null,
    dnsInspection: null,
    tunnelInspection: null,
    dryRun: null,
    apply: {
      attempted: false,
      confirmationStatus: "NOT_REQUESTED",
      confirmationHash: null,
      status: "NOT_REQUESTED",
      checkpoint: "NOT_STARTED",
      changes: [],
      ownedResources: [],
    },
    secondRun: {
      attempted: false,
      status: "NOT_REQUESTED",
      duplicateCreates: null,
      ownedTunnelMatched: null,
      ownedDnsMatched: null,
      ingressMatched: null,
      mutationDelta: null,
    },
    cleanup: {
      attempted: false,
      confirmationStatus: "NOT_REQUESTED",
      confirmationHash: null,
      status: "NOT_REQUESTED",
      checkpoint: "NOT_STARTED",
      deletedResources: [],
    },
    apiRequests: [],
    failure: null,
    secretScan: null,
  };
}

function normalizeCredentialType(value) {
  return ["SCOPED_API_TOKEN", "GLOBAL_API_KEY", "UNKNOWN"].includes(value) ? value : "UNKNOWN";
}

function assertEnvironmentName(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value)) {
    throw new RunnerFault(`TEST_ENVIRONMENT_${field}_INVALID`);
  }
  return value;
}

function readEnvironmentValue(environment, name) {
  const value = environment[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function registerSensitiveValue(registry, value) {
  if (typeof value === "string" && value.length > 0 && !registry.includes(value)) registry.push(value);
}

function credentialCheckpoint(code, sensitiveValues) {
  return { checkpoint: code, sensitiveValues: [...sensitiveValues] };
}

function validateManifest(document, schema) {
  const analysis = analyzeTestEnvironment(document, schema);
  if (analysis.errors.length > 0 || analysis.secretValues !== 0) {
    throw new RunnerFault("TEST_ENVIRONMENT_V2_INVALID");
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new RunnerFault("TEST_ENVIRONMENT_INVALID");
  }
  if (document.schemaVersion !== "2.0") throw new RunnerFault("TEST_ENVIRONMENT_SCHEMA_VERSION_UNSUPPORTED");
  const cloudflare = document.cloudflare;
  if (cloudflare === null || typeof cloudflare !== "object" || Array.isArray(cloudflare)) {
    throw new RunnerFault("TEST_ENVIRONMENT_CLOUDFLARE_INVALID");
  }
  if (cloudflare.zoneName !== FIXED_ZONE || cloudflare.preferredHostname !== FIXED_HOSTNAME) {
    throw new RunnerFault("TARGET_OUTSIDE_FIXED_ALLOWLIST");
  }
  if (cloudflare.available !== true) {
    throw new RunnerFault("CLOUDFLARE_ENVIRONMENT_UNAVAILABLE", "BLOCKED_BY_EXTERNAL_ACCOUNT");
  }
  const credentialType = normalizeCredentialType(cloudflare.credentialType);
  if (credentialType !== cloudflare.credentialType) throw new RunnerFault("CREDENTIAL_TYPE_INVALID");
  return { cloudflare, credentialType };
}

async function loadManifest(manifestPath) {
  let text;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch (error) {
    throw new RunnerFault(
      error?.code === "ENOENT" ? "TEST_ENVIRONMENT_MISSING" : "TEST_ENVIRONMENT_UNREADABLE",
      error?.code === "ENOENT" ? "NEEDS_HUMAN_CHECKPOINT" : "FAIL",
    );
  }
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new RunnerFault("TEST_ENVIRONMENT_TOO_LARGE");
  try {
    return JSON.parse(text);
  } catch {
    throw new RunnerFault("TEST_ENVIRONMENT_INVALID_JSON");
  }
}

async function loadManifestSchema(schemaPath) {
  try {
    return JSON.parse(await readFile(schemaPath, "utf8"));
  } catch {
    throw new RunnerFault("TEST_ENVIRONMENT_SCHEMA_UNREADABLE");
  }
}

async function loadEvidenceSchema(schemaPath) {
  try {
    return JSON.parse(await readFile(schemaPath, "utf8"));
  } catch {
    throw new RunnerFault("CLOUDFLARE_EVIDENCE_SCHEMA_UNREADABLE");
  }
}

function jsonSchemaErrors(value, schema, root, location = "$") {
  if (schema === true) return [];
  if (schema === false) return [`${location}:falseSchema`];
  if (schema?.$ref !== undefined) {
    const segments = schema.$ref.replace(/^#\//u, "").split("/");
    let target = root;
    for (const segment of segments) target = target?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
    return target === undefined ? [`${location}:ref`] : jsonSchemaErrors(value, target, root, location);
  }
  if (Array.isArray(schema?.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => jsonSchemaErrors(value, candidate, root, location).length === 0);
    return matches.length === 1 ? [] : [`${location}:oneOf`];
  }
  const allowedTypes = Array.isArray(schema?.type) ? schema.type : schema?.type === undefined ? [] : [schema.type];
  const actualType = value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : Number.isInteger(value)
        ? "integer"
        : typeof value === "number"
          ? "number"
          : typeof value;
  if (allowedTypes.length > 0
    && !allowedTypes.includes(actualType)
    && !(actualType === "integer" && allowedTypes.includes("number"))) {
    return [`${location}:type`];
  }
  const errors = [];
  if (Object.hasOwn(schema, "const") && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${location}:const`);
  }
  if (Array.isArray(schema?.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push(`${location}:enum`);
  }
  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${location}:pattern`);
    }
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) errors.push(`${location}:format`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${location}:minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${location}:maximum`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${location}:minItems`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${location}:maxItems`);
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      errors.push(`${location}:uniqueItems`);
    }
    if (Array.isArray(schema.prefixItems)) {
      schema.prefixItems.forEach((itemSchema, index) => {
        if (index < value.length) errors.push(...jsonSchemaErrors(value[index], itemSchema, root, `${location}[${index}]`));
      });
      if (schema.items === false && value.length > schema.prefixItems.length) errors.push(`${location}:items`);
    } else if (schema.items !== undefined) {
      value.forEach((item, index) => errors.push(...jsonSchemaErrors(item, schema.items, root, `${location}[${index}]`)));
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${location}.${key}:required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) errors.push(`${location}.${key}:additional`);
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        errors.push(...jsonSchemaErrors(value[key], propertySchema, root, `${location}.${key}`));
      }
    }
  }
  return errors;
}

function assertEvidenceSchema(evidence, schema, code) {
  if (jsonSchemaErrors(evidence, schema, schema).length > 0) throw new RunnerFault(code);
}

async function evidenceSchemaFor(options) {
  if (options.evidenceSchema === undefined) {
    options.evidenceSchema = await loadEvidenceSchema(options.evidenceSchemaPath);
  }
  return options.evidenceSchema;
}

/**
 * Resolves only the selected credential mode. In Global mode the email is
 * validated before the Key environment property is ever read.
 */
export function resolveCredentialFromEnvironment(cloudflare, environment, sensitiveValues = []) {
  if (cloudflare.credentialType === "UNKNOWN") {
    return credentialCheckpoint("CREDENTIAL_TYPE_SELECTION_REQUIRED", sensitiveValues);
  }
  if (cloudflare.credentialAvailable !== true) {
    return credentialCheckpoint("CREDENTIAL_LOCAL_ENTRY_REQUIRED", sensitiveValues);
  }

  if (cloudflare.credentialType === "SCOPED_API_TOKEN") {
    const name = assertEnvironmentName(cloudflare.apiTokenEnv, "API_TOKEN_ENV");
    const token = readEnvironmentValue(environment, name);
    registerSensitiveValue(sensitiveValues, token);
    if (token === null) return credentialCheckpoint("SCOPED_TOKEN_ENV_VALUE_REQUIRED", sensitiveValues);
    if (token !== token.trim() || token.length < 20 || token.length > 4096) {
      return credentialCheckpoint("SCOPED_TOKEN_ENV_VALUE_INVALID", sensitiveValues);
    }
    return {
      credential: { kind: "api_token", token },
      sensitiveValues: [...sensitiveValues],
    };
  }

  const emailName = assertEnvironmentName(cloudflare.globalEmailEnv, "GLOBAL_EMAIL_ENV");
  const email = readEnvironmentValue(environment, emailName);
  registerSensitiveValue(sensitiveValues, email);
  if (email === null) {
    // Do not dereference globalKeyEnv here. This ordering is a security property.
    return credentialCheckpoint("GLOBAL_KEY_EMAIL_ENV_VALUE_REQUIRED", sensitiveValues);
  }
  if (email !== email.trim() || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    return credentialCheckpoint("GLOBAL_KEY_EMAIL_ENV_VALUE_INVALID", sensitiveValues);
  }
  const keyName = assertEnvironmentName(cloudflare.globalKeyEnv, "GLOBAL_KEY_ENV");
  const key = readEnvironmentValue(environment, keyName);
  registerSensitiveValue(sensitiveValues, key);
  if (key === null) return credentialCheckpoint("GLOBAL_KEY_ENV_VALUE_REQUIRED", sensitiveValues);
  if (key !== key.trim() || key.length < 20 || key.length > 4096) {
    return credentialCheckpoint("GLOBAL_KEY_ENV_VALUE_INVALID", sensitiveValues);
  }
  return {
    credential: { kind: "global_api_key", email, key },
    sensitiveValues: [...sensitiveValues],
  };
}

function requestHeaders(credential, hasBody) {
  const headers = new Headers({ Accept: "application/json" });
  if (hasBody) headers.set("Content-Type", "application/json");
  if (credential.kind === "api_token") {
    headers.set("Authorization", `Bearer ${credential.token}`);
  } else {
    headers.set("X-Auth-Email", credential.email);
    headers.set("X-Auth-Key", credential.key);
  }
  return headers;
}

function apiFault(status, envelope) {
  const codes = Array.isArray(envelope?.errors)
    ? envelope.errors.map((item) => item?.code).filter((code) => Number.isInteger(code)).slice(0, 20)
    : [];
  const classification = status === 401 || status === 403
    ? "BLOCKED_BY_EXTERNAL_ACCOUNT"
    : status === 429 || status >= 500
      ? "BLOCKED_BY_ENVIRONMENT"
      : "FAIL";
  return new RunnerFault("CLOUDFLARE_API_REJECTED", classification, {
    httpStatus: status,
    cloudflareErrorCodes: codes,
  });
}

function retryDelay(response, attempt) {
  const seconds = Number(response.headers.get("retry-after"));
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 1000);
  return Math.min(100 * 2 ** (attempt - 1), 1000);
}

function createCloudflareClient({ credential, fetchImplementation, requestLog, sleep }) {
  async function request({ operation, method = "GET", resourcePath, query, body }) {
    if (!resourcePath.startsWith("/")) throw new RunnerFault("INTERNAL_API_PATH_INVALID");
    const url = new URL(`${CLOUDFLARE_API_ORIGIN}${API_PREFIX}${resourcePath}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    if (url.origin !== CLOUDFLARE_API_ORIGIN || !url.pathname.startsWith(`${API_PREFIX}/`)) {
      throw new RunnerFault("INTERNAL_API_ORIGIN_INVALID");
    }
    const attempts = method === "GET" ? 3 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response;
      try {
        response = await fetchImplementation(url, {
          method,
          headers: requestHeaders(credential, body !== undefined),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        requestLog.push({ operation, method, attempt, status: null, outcome: "NETWORK_ERROR" });
        if (method === "GET" && attempt < attempts) {
          await sleep(Math.min(100 * attempt, 500));
          continue;
        }
        throw new RunnerFault("CLOUDFLARE_NETWORK_REQUEST_FAILED", "BLOCKED_BY_ENVIRONMENT", {
          outcomeUnknown: method !== "GET",
        });
      }
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        throw new RunnerFault("CLOUDFLARE_RESPONSE_TOO_LARGE", "BLOCKED_BY_ENVIRONMENT", {
          outcomeUnknown: method !== "GET",
        });
      }
      let text;
      try {
        text = await response.text();
      } catch {
        requestLog.push({ operation, method, attempt, status: response.status, outcome: "INVALID_RESPONSE" });
        throw new RunnerFault("CLOUDFLARE_RESPONSE_INVALID", "BLOCKED_BY_ENVIRONMENT", {
          httpStatus: response.status,
          outcomeUnknown: method !== "GET",
        });
      }
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
        throw new RunnerFault("CLOUDFLARE_RESPONSE_TOO_LARGE", "BLOCKED_BY_ENVIRONMENT", {
          outcomeUnknown: method !== "GET",
        });
      }
      let envelope;
      try {
        envelope = JSON.parse(text);
      } catch {
        requestLog.push({ operation, method, attempt, status: response.status, outcome: "INVALID_RESPONSE" });
        throw new RunnerFault("CLOUDFLARE_RESPONSE_INVALID", "BLOCKED_BY_ENVIRONMENT", {
          httpStatus: response.status,
          outcomeUnknown: method !== "GET",
        });
      }
      if (response.ok && envelope?.success === true) {
        requestLog.push({ operation, method, attempt, status: response.status, outcome: "SUCCESS" });
        return envelope;
      }
      requestLog.push({ operation, method, attempt, status: response.status, outcome: "REJECTED" });
      if (method === "GET" && attempt < attempts && [429, 502, 503, 504].includes(response.status)) {
        await sleep(retryDelay(response, attempt));
        continue;
      }
      const fault = apiFault(response.status, envelope);
      if (method !== "GET"
        && (response.status >= 500 || (response.ok && envelope?.success !== false))) {
        fault.outcomeUnknown = true;
      }
      throw fault;
    }
    throw new RunnerFault("CLOUDFLARE_RETRY_EXHAUSTED", "BLOCKED_BY_ENVIRONMENT");
  }

  async function pages({ operation, resourcePath, query = {} }) {
    const items = [];
    let page = 1;
    while (page <= MAX_PAGES) {
      const envelope = await request({
        operation,
        resourcePath,
        query: { ...query, page, per_page: 100 },
      });
      if (!Array.isArray(envelope.result)) throw new RunnerFault("CLOUDFLARE_RESPONSE_SHAPE_INVALID");
      items.push(...envelope.result);
      const totalPages = Number(envelope.result_info?.total_pages ?? 1);
      if (!Number.isInteger(totalPages) || totalPages < 1 || totalPages > MAX_PAGES) {
        throw new RunnerFault("CLOUDFLARE_PAGINATION_LIMIT_EXCEEDED", "BLOCKED_BY_ENVIRONMENT");
      }
      if (page >= totalPages) return items;
      page += 1;
    }
    throw new RunnerFault("CLOUDFLARE_PAGINATION_LIMIT_EXCEEDED", "BLOCKED_BY_ENVIRONMENT");
  }

  return {
    async verifyCredential() {
      if (credential.kind === "api_token") {
        await request({ operation: "VERIFY_SCOPED_TOKEN", resourcePath: "/user/tokens/verify" });
        return;
      }
      const envelope = await request({ operation: "VERIFY_GLOBAL_KEY", resourcePath: "/user" });
      if (typeof envelope.result?.email !== "string"
        || envelope.result.email.toLowerCase() !== credential.email.toLowerCase()) {
        throw new RunnerFault("GLOBAL_KEY_EMAIL_MISMATCH", "BLOCKED_BY_EXTERNAL_ACCOUNT");
      }
    },
    listZones(accountId) {
      return pages({
        operation: "RESOLVE_ZONE",
        resourcePath: "/zones",
        query: { name: FIXED_ZONE, ...(accountId === null ? {} : { "account.id": accountId }) },
      });
    },
    listDns(zoneId, hostname = FIXED_HOSTNAME) {
      return pages({
        operation: "INSPECT_DNS",
        resourcePath: `/zones/${encodeURIComponent(zoneId)}/dns_records`,
        query: { name: hostname },
      });
    },
    listTunnels(accountId) {
      return pages({
        operation: "INSPECT_TUNNELS",
        resourcePath: `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`,
        query: { is_deleted: "false" },
      });
    },
    async createTunnel(accountId, name) {
      const envelope = await request({
        operation: "CREATE_OWNED_TUNNEL",
        method: "POST",
        resourcePath: `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`,
        body: { name, config_src: "cloudflare" },
      });
      return envelope.result;
    },
    async readTunnelConfig(accountId, tunnelId) {
      const envelope = await request({
        operation: "VERIFY_OWNED_TUNNEL_CONFIG",
        resourcePath: `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
      });
      return envelope.result?.config;
    },
    async updateTunnelConfig(accountId, tunnelId, config) {
      const envelope = await request({
        operation: "CONFIGURE_OWNED_TUNNEL",
        method: "PUT",
        resourcePath: `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
        body: { config },
      });
      return envelope.result?.config;
    },
    async createDns(zoneId, record) {
      const envelope = await request({
        operation: "CREATE_OWNED_DNS",
        method: "POST",
        resourcePath: `/zones/${encodeURIComponent(zoneId)}/dns_records`,
        body: record,
      });
      return envelope.result;
    },
    async deleteDns(zoneId, recordId) {
      const envelope = await request({
        operation: "DELETE_OWNED_DNS",
        method: "DELETE",
        resourcePath: `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
      });
      if (envelope.result?.id !== recordId) {
        throw new RunnerFault("DELETE_DNS_RESPONSE_MISMATCH", "NEEDS_HUMAN_CHECKPOINT", {
          outcomeUnknown: true,
        });
      }
    },
    async deleteTunnel(accountId, tunnelId) {
      const envelope = await request({
        operation: "DELETE_OWNED_TUNNEL",
        method: "DELETE",
        resourcePath: `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`,
      });
      if (envelope.result?.id !== tunnelId) {
        throw new RunnerFault("DELETE_TUNNEL_RESPONSE_MISMATCH", "NEEDS_HUMAN_CHECKPOINT", {
          outcomeUnknown: true,
        });
      }
    },
  };
}

function cloudflareId(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(value)) {
    throw new RunnerFault(`CLOUDFLARE_${field}_INVALID`);
  }
  return value;
}

function tunnelName(value) {
  if (typeof value !== "string" || !/^toolspan-e2e-[a-z0-9-]{1,80}$/u.test(value)) {
    throw new RunnerFault("CLOUDFLARE_TUNNEL_NAME_INVALID");
  }
  return value;
}

function dnsFingerprint(record) {
  return sha256({
    id: record.id,
    type: record.type,
    name: record.name,
    content: record.content,
    proxied: record.proxied === true,
    ttl: record.ttl === undefined ? null : Number(record.ttl),
  });
}

function tunnelFingerprint(record, accountId) {
  return sha256({ id: record.id, name: record.name, accountId });
}

function normalizeZoneStatus(value) {
  const normalized = typeof value === "string" ? value.toUpperCase() : "UNKNOWN";
  return ["ACTIVE", "PENDING", "INITIALIZING", "MOVED", "DEACTIVATED"].includes(normalized)
    ? normalized
    : "UNKNOWN";
}

function safeNameservers(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && /^[a-z0-9-]+\.ns\.cloudflare\.com$/u.test(item))
    .slice(0, 10);
}

function expectedIngress(hostname = FIXED_HOSTNAME) {
  return {
    ingress: [
      { hostname, service: LOCAL_SERVICE },
      { service: "http_status:404" },
    ],
  };
}

function plannedMutationPayloads(hostname, desiredTunnelName) {
  return {
    tunnel: { name: desiredTunnelName, configSrc: "cloudflare" },
    ingress: expectedIngress(hostname),
    dns: {
      type: "CNAME",
      name: hostname,
      contentSource: "CREATED_TUNNEL_ID",
      contentSuffix: ".cfargotunnel.com",
      proxied: true,
      ttl: 1,
    },
  };
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]),
    );
  }
  return value;
}

function configsEqual(left, right) {
  return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}

function tunnelConfigsEqual(actual, expected) {
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)
    || expected === null || typeof expected !== "object" || Array.isArray(expected)
    || !Array.isArray(actual.ingress) || !Array.isArray(expected.ingress)
    || Object.keys(expected).length !== 1 || !Object.hasOwn(expected, "ingress")) return false;
  const actualKeys = Object.keys(actual).sort();
  if (!configsEqual(actualKeys, ["ingress"])
    && !configsEqual(actualKeys, ["ingress", "warp-routing"])) return false;
  if (Object.hasOwn(actual, "warp-routing")) {
    const warpRouting = actual["warp-routing"];
    if (warpRouting === null || typeof warpRouting !== "object" || Array.isArray(warpRouting)
      || !configsEqual(Object.keys(warpRouting).sort(), ["enabled"])
      || warpRouting.enabled !== false) return false;
  }
  return configsEqual(actual.ingress, expected.ingress);
}

function ownedTunnelSemanticsMatch(tunnel, desiredTunnelName) {
  return tunnel !== undefined
    && tunnel.desired === true
    && tunnel.name === desiredTunnelName
    && tunnel.raw?.name === desiredTunnelName;
}

function ownedResourceSemanticsMatch({ tunnel, dns, desiredTunnelName, hostname }) {
  return ownedTunnelSemanticsMatch(tunnel, desiredTunnelName)
    && dns !== undefined
    && dns.exactTarget === true
    && dns.raw?.type === "CNAME"
    && dns.raw?.name === hostname
    && dns.raw?.content === `${tunnel.id}.cfargotunnel.com`
    && dns.raw?.proxied === true
    && Number(dns.raw?.ttl) === 1;
}

function inspectionFingerprint(inspection) {
  return sha256({
    zone: inspection.zone === null
      ? null
      : {
          id: inspection.zone.id,
          accountId: inspection.zone.accountId,
          status: inspection.zone.status,
        },
    dns: inspection.raw.dns
      .map((item) => ({ id: item.id, fingerprint: dnsFingerprint(item.raw), owned: item.owned }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    tunnels: inspection.raw.tunnels
      .map((item) => ({
        id: item.id,
        fingerprint: tunnelFingerprint(item.raw, inspection.zone?.accountId ?? ""),
        status: item.status,
        owned: item.owned,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
}

function dryRunHash({
  hostname,
  desiredTunnelName,
  zoneId,
  accountId,
  targetInspectionFingerprint,
  changes,
  mutationPayloads,
  blockers,
}) {
  return sha256({
    target: { zoneName: FIXED_ZONE, hostname, desiredTunnelName },
    zoneId,
    accountId,
    inspectionFingerprint: targetInspectionFingerprint,
    changes,
    mutationPayloads,
    blockers,
    unknownResourcesUntouched: true,
  });
}

async function inspectTarget({ client, configuredZoneId, configuredAccountId, desiredTunnelName, ownership, hostname = FIXED_HOSTNAME }) {
  const zones = await client.listZones(configuredAccountId);
  const exactZones = zones.filter((zone) => zone?.name === FIXED_ZONE);
  if (exactZones.length === 0) {
    return {
      zone: null,
      dns: null,
      tunnels: null,
      raw: { zone: null, dns: [], tunnels: [] },
    };
  }
  if (exactZones.length !== 1) throw new RunnerFault("ZONE_RESOLUTION_AMBIGUOUS");
  const rawZone = exactZones[0];
  const zoneId = cloudflareId(rawZone.id, "ZONE_ID");
  const accountId = cloudflareId(rawZone.account?.id, "ACCOUNT_ID");
  if (configuredZoneId !== null && configuredZoneId !== zoneId) {
    throw new RunnerFault("CONFIGURED_ZONE_ID_MISMATCH");
  }
  if (configuredAccountId !== null && configuredAccountId !== accountId) {
    throw new RunnerFault("CONFIGURED_ACCOUNT_ID_MISMATCH");
  }

  const rawDns = await client.listDns(zoneId, hostname);
  const dns = rawDns.map((record) => {
    const id = cloudflareId(record?.id, "DNS_ID");
    const exactTarget = record?.name === hostname;
    const owned = exactTarget
      && ownership?.dns?.id === id
      && ownership.dns.fingerprint === dnsFingerprint(record);
    return {
      id,
      type: ["A", "AAAA", "CNAME", "TXT"].includes(record?.type) ? record.type : "OTHER",
      exactTarget,
      owned,
      raw: record,
    };
  });

  const allTunnels = await client.listTunnels(accountId);
  const prefixed = allTunnels
    .filter((item) => typeof item?.name === "string" && item.name.startsWith(TUNNEL_PREFIX))
    .map((item) => {
      const id = cloudflareId(item.id, "TUNNEL_ID");
      const name = tunnelName(item.name);
      const owned = ownership?.tunnel?.id === id
        && ownership.tunnel.fingerprint === tunnelFingerprint(item, accountId);
      return {
        id,
        name,
        status: ["healthy", "degraded", "down", "inactive"].includes(item.status)
          ? item.status.toUpperCase()
          : "UNKNOWN",
        desired: name === desiredTunnelName,
        owned,
        raw: item,
      };
    });

  return {
    zone: {
      id: zoneId,
      accountId,
      status: normalizeZoneStatus(rawZone.status),
      assignedNameservers: safeNameservers(rawZone.name_servers),
    },
    dns: {
      hostname,
      recordCount: dns.length,
      unknownCount: dns.filter((item) => !item.owned).length,
      collision: dns.some((item) => !item.owned),
      records: dns.slice(0, 50).map(({ id, type, owned }) => ({
        id,
        type,
        ownership: owned ? "CURRENT_SESSION" : "UNKNOWN",
      })),
      truncated: dns.length > 50,
    },
    tunnels: {
      prefix: TUNNEL_PREFIX,
      desiredName: desiredTunnelName,
      prefixedCount: prefixed.length,
      unknownCount: prefixed.filter((item) => !item.owned).length,
      desiredCollision: prefixed.some((item) => item.desired && !item.owned),
      records: prefixed.slice(0, 50).map(({ id, name, status, desired, owned }) => ({
        id,
        name,
        status,
        desired,
        ownership: owned ? "CURRENT_SESSION" : "UNKNOWN_UNTOUCHED",
      })),
      truncated: prefixed.length > 50,
    },
    raw: {
      zone: rawZone,
      dns,
      tunnels: prefixed,
    },
  };
}

function buildDryRun(inspection, desiredTunnelName, ownership, hostname = FIXED_HOSTNAME) {
  const changes = ownership === null
    ? [
        { order: 1, action: "CREATE", resource: "TUNNEL", target: desiredTunnelName, ownership: "NEW_SESSION_ONLY" },
        { order: 2, action: "CONFIGURE", resource: "TUNNEL_INGRESS", target: desiredTunnelName, ownership: "CURRENT_SESSION_ONLY" },
        { order: 3, action: "CREATE", resource: "DNS_CNAME", target: hostname, ownership: "NEW_SESSION_ONLY" },
      ]
    : [];
  const blockers = [];
  if (inspection.zone === null) blockers.push("ZONE_NOT_FOUND");
  if (inspection.zone !== null && inspection.zone.status !== "ACTIVE") blockers.push("ZONE_NOT_ACTIVE");
  if (inspection.dns?.collision === true) blockers.push("UNKNOWN_DNS_COLLISION");
  if (inspection.tunnels?.desiredCollision === true) blockers.push("UNKNOWN_DESIRED_TUNNEL_COLLISION");
  const zoneId = inspection.zone?.id ?? null;
  const accountId = inspection.zone?.accountId ?? null;
  const targetInspectionFingerprint = inspectionFingerprint(inspection);
  const mutationPayloads = plannedMutationPayloads(hostname, desiredTunnelName);
  return {
    executable: blockers.length === 0,
    planHash: dryRunHash({
      hostname,
      desiredTunnelName,
      zoneId,
      accountId,
      targetInspectionFingerprint,
      changes,
      mutationPayloads,
      blockers,
    }),
    zoneId,
    accountId,
    inspectionFingerprint: targetInspectionFingerprint,
    mutationPayloads,
    mutationCount: changes.length,
    createCount: changes.filter((item) => item.action === "CREATE").length,
    blockers,
    unknownResourcesUntouched: true,
    changes,
  };
}

function safeFailure(error) {
  if (error instanceof RunnerFault) {
    return {
      classification: TERMINAL_STATUSES.has(error.classification) ? error.classification : "FAIL",
      code: error.code,
      httpStatus: Number.isInteger(error.httpStatus) ? error.httpStatus : null,
      cloudflareErrorCodes: error.cloudflareErrorCodes,
    };
  }
  return {
    classification: "FAIL",
    code: "UNEXPECTED_RUNNER_FAILURE",
    httpStatus: null,
    cloudflareErrorCodes: [],
  };
}

function setFaultEvidence(evidence, error) {
  const failure = safeFailure(error);
  evidence.status = failure.classification;
  evidence.decision = "STOP";
  evidence.reason = failure.code;
  evidence.failure = failure;
  if (evidence.apply.status === "IN_PROGRESS") evidence.apply.status = "PARTIAL_STOPPED";
  if (evidence.cleanup.status === "IN_PROGRESS") evidence.cleanup.status = "STOPPED";
}

export function scanSanitizedEvidence(evidence, sensitiveValues = []) {
  const forbiddenFields = [];
  const secrets = [...new Set(sensitiveValues.filter((value) => typeof value === "string" && value.length > 0))];
  const matched = new Set();
  const encoded = new Map(secrets.map((value) => [value, JSON.stringify(value).slice(1, -1)]));
  function visit(value, location) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    if (typeof value === "string") {
      for (const secret of secrets) {
        const escaped = encoded.get(secret);
        if (value === secret || value === escaped
          || (secret.length >= 8 && value.includes(secret))
          || (escaped.length >= 8 && value.includes(escaped))) matched.add(secret);
      }
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/(?:secret|password|passphrase|token|api.?key|authorization|cookie|email)/iu.test(key)
        && !ALLOWED_EVIDENCE_SECRET_LIKE_FIELDS.has(key)) {
        forbiddenFields.push(`${location}.${key}`);
      }
      visit(child, `${location}.${key}`);
    }
  }
  visit(evidence, "$evidence");
  const serialized = JSON.stringify(evidence);
  for (const secret of secrets) {
    if (serialized.includes(JSON.stringify(secret))) matched.add(secret);
  }
  return {
    status: forbiddenFields.length === 0 && matched.size === 0 ? "PASS" : "FAIL",
    forbiddenFieldCount: forbiddenFields.length,
    matchedSecretValues: matched.size,
  };
}

async function finalizeEvidence(evidence, sensitiveValues, options) {
  evidence.secretScan = null;
  const scan = scanSanitizedEvidence(evidence, sensitiveValues);
  if (scan.status !== "PASS") throw new RunnerFault("SANITIZED_EVIDENCE_SECRET_SCAN_FAILED");
  evidence.secretScan = scan;
  const finalScan = scanSanitizedEvidence(evidence, sensitiveValues);
  if (finalScan.status !== "PASS") throw new RunnerFault("SANITIZED_EVIDENCE_SECRET_SCAN_FAILED");
  assertEvidenceSchema(
    evidence,
    await evidenceSchemaFor(options),
    "GENERATED_CLOUDFLARE_EVIDENCE_SCHEMA_INVALID",
  );

  let evidencePath = null;
  if (options.writeEvidence !== false) {
    await mkdir(options.evidenceDirectory, { recursive: true, mode: 0o700 });
    const directory = path.resolve(options.evidenceDirectory);
    const filename = `cloudflare-e2e-${checkedSessionId(evidence.sessionId)}.json`;
    evidencePath = path.join(directory, filename);
    if (path.dirname(evidencePath) !== directory) throw new RunnerFault("EVIDENCE_PATH_OUTSIDE_FIXED_ROOT");
    const temporaryPath = `${evidencePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, evidencePath);
    } finally {
      await unlink(temporaryPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }
  return { evidence, evidencePath };
}

async function persistMutationCheckpoint(evidence, sensitiveValues, options) {
  if (options.writeEvidence === false) {
    throw new RunnerFault("DURABLE_RECEIPT_REQUIRED", "NEEDS_HUMAN_CHECKPOINT");
  }
  await finalizeEvidence(evidence, sensitiveValues, options);
}

async function loadReceipt(options, id) {
  const directory = path.resolve(options.evidenceDirectory);
  const filename = `cloudflare-e2e-${checkedSessionId(id)}.json`;
  const receiptPath = path.join(directory, filename);
  if (path.dirname(receiptPath) !== directory) throw new RunnerFault("EVIDENCE_PATH_OUTSIDE_FIXED_ROOT");
  let text;
  try {
    text = await readFile(receiptPath, "utf8");
  } catch (error) {
    throw new RunnerFault(
      error?.code === "ENOENT" ? "RECONCILE_RECEIPT_MISSING" : "RECONCILE_RECEIPT_UNREADABLE",
      error?.code === "ENOENT" ? "NEEDS_HUMAN_CHECKPOINT" : "FAIL",
    );
  }
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new RunnerFault("RECONCILE_RECEIPT_TOO_LARGE");
  }
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    throw new RunnerFault("RECONCILE_RECEIPT_INVALID_JSON");
  }
  assertEvidenceSchema(
    receipt,
    await evidenceSchemaFor(options),
    "RECONCILE_RECEIPT_SCHEMA_INVALID",
  );
  if (scanSanitizedEvidence(receipt).status !== "PASS") {
    throw new RunnerFault("RECONCILE_RECEIPT_SECRET_SCAN_FAILED");
  }
  return receipt;
}

function operationConfirmationHash(operation, evidence) {
  if (operation === "APPLY") return evidence.dryRun.planHash;
  return sha256({
    operation,
    sessionId: evidence.sessionId,
    zoneId: evidence.zone.id,
    accountId: evidence.zone.accountId,
    hostname: evidence.target.hostname,
    tunnelName: evidence.tunnelInspection.desiredName,
    ownedResources: [...evidence.apply.ownedResources]
      .map((item) => ({ kind: item.kind, id: item.id, fingerprint: item.fingerprint }))
      .sort((left, right) => left.kind.localeCompare(right.kind)),
    expectedIngress: expectedIngress(evidence.target.hostname),
  });
}

function confirmationText(operation, evidence, bytes, confirmationHash) {
  const nonce = bytes(8).toString("hex");
  return `CONFIRM TOOLSPAN CLOUDFLARE ${operation} ${evidence.sessionId} ${confirmationHash} ${nonce}`;
}

function confirmationSummary(operation, evidence) {
  const confirmationHash = operationConfirmationHash(operation, evidence);
  const common = {
    operation,
    zone: {
      name: evidence.target.zoneName,
      id: evidence.zone.id,
      accountId: evidence.zone.accountId,
      status: evidence.zone.status,
    },
    hostname: evidence.target.hostname,
    tunnelName: evidence.tunnelInspection.desiredName,
    planHash: evidence.dryRun.planHash,
    confirmationHash,
  };
  if (operation === "APPLY") {
    return { ...common, plan: structuredClone(evidence.dryRun) };
  }
  return {
    ...common,
    ownedResources: structuredClone(evidence.apply.ownedResources),
    expectedIngress: expectedIngress(evidence.target.hostname),
  };
}

async function consumeConfirmation({ operation, evidence, channel, bytes, consumed }) {
  const confirmationHash = operationConfirmationHash(operation, evidence);
  if (operation === "APPLY") evidence.apply.confirmationHash = confirmationHash;
  else evidence.cleanup.confirmationHash = confirmationHash;
  const expected = confirmationText(operation, evidence, bytes, confirmationHash);
  if (consumed.has(expected)) return false;
  const summary = confirmationSummary(operation, evidence);
  const received = await channel({
    operation,
    expected,
    planHash: evidence.dryRun.planHash,
    confirmationHash,
    summary,
  });
  if (received !== expected) return false;
  consumed.add(expected);
  return true;
}

function interactiveConfirmationChannel() {
  return async ({ expected, summary }) => {
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return null;
    process.stdout.write(`\nOne-time confirmation required. Review this sanitized exact plan:\n${JSON.stringify(summary, null, 2)}\nType exactly:\n${expected}\n> `);
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await reader.question("")).trim();
    } finally {
      reader.close();
    }
  };
}

function applyOwnedResource(kind, record, accountOrZoneId) {
  if (kind === "TUNNEL") {
    return {
      kind,
      id: record.id,
      fingerprint: tunnelFingerprint(record, accountOrZoneId),
    };
  }
  return {
    kind,
    id: record.id,
    fingerprint: dnsFingerprint(record),
  };
}

function ownershipFromApply(evidence) {
  const tunnel = evidence.apply.ownedResources.find((item) => item.kind === "TUNNEL");
  const dns = evidence.apply.ownedResources.find((item) => item.kind === "DNS_CNAME");
  return tunnel === undefined || dns === undefined ? null : { tunnel, dns };
}

function partialOwnershipFromApply(evidence) {
  return {
    tunnel: evidence.apply.ownedResources.find((item) => item.kind === "TUNNEL"),
    dns: evidence.apply.ownedResources.find((item) => item.kind === "DNS_CNAME"),
  };
}

export function validateReconcileReceipt(receipt, id) {
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)
    || receipt.schemaVersion !== "2.0"
    || receipt.evidenceType !== "TOOLSPAN_CLOUDFLARE_API_E2E"
    || receipt.sessionId !== id
    || !["APPLY", "RECONCILE"].includes(receipt.mode)
    || receipt.target?.zoneName !== FIXED_ZONE
    || receipt.target?.preferredHostname !== FIXED_HOSTNAME) {
    throw new RunnerFault("RECONCILE_RECEIPT_INVALID");
  }
  const expectedFallback = `mcp-e2e-${id}.${FIXED_ZONE}`;
  if (![FIXED_HOSTNAME, expectedFallback].includes(receipt.target?.hostname)) {
    throw new RunnerFault("RECONCILE_RECEIPT_TARGET_INVALID");
  }
  if ((receipt.target.hostname === FIXED_HOSTNAME && receipt.target.hostnameSelection !== "PREFERRED")
    || (receipt.target.hostname === expectedFallback && receipt.target.hostnameSelection !== "SESSION_FALLBACK")) {
    throw new RunnerFault("RECONCILE_RECEIPT_TARGET_INVALID");
  }
  if (receipt.tunnelInspection?.desiredName !== `${TUNNEL_PREFIX}${id}`) {
    throw new RunnerFault("RECONCILE_RECEIPT_TUNNEL_INVALID");
  }
  cloudflareId(receipt.zone?.id, "ZONE_ID");
  cloudflareId(receipt.zone?.accountId, "ACCOUNT_ID");
  if (typeof receipt.dryRun?.planHash !== "string" || !/^[a-f0-9]{64}$/u.test(receipt.dryRun.planHash)) {
    throw new RunnerFault("RECONCILE_RECEIPT_PLAN_INVALID");
  }
  if (receipt.dryRun.zoneId !== receipt.zone.id
    || receipt.dryRun.accountId !== receipt.zone.accountId
    || typeof receipt.dryRun.inspectionFingerprint !== "string"
    || !/^[a-f0-9]{64}$/u.test(receipt.dryRun.inspectionFingerprint)
    || !Array.isArray(receipt.dryRun.changes)
    || receipt.dryRun.mutationPayloads === null
    || typeof receipt.dryRun.mutationPayloads !== "object"
    || !configsEqual(
      receipt.dryRun.mutationPayloads,
      plannedMutationPayloads(receipt.target.hostname, receipt.tunnelInspection.desiredName),
    )
    || !Array.isArray(receipt.dryRun.blockers)
    || receipt.dryRun.unknownResourcesUntouched !== true
    || receipt.dryRun.executable !== (receipt.dryRun.blockers.length === 0)
    || receipt.dryRun.mutationCount !== receipt.dryRun.changes.length
    || receipt.dryRun.createCount !== receipt.dryRun.changes.filter((item) => item?.action === "CREATE").length
    || receipt.dryRun.planHash !== dryRunHash({
      hostname: receipt.target.hostname,
      desiredTunnelName: receipt.tunnelInspection.desiredName,
      zoneId: receipt.dryRun.zoneId,
      accountId: receipt.dryRun.accountId,
      targetInspectionFingerprint: receipt.dryRun.inspectionFingerprint,
      changes: receipt.dryRun.changes,
      mutationPayloads: receipt.dryRun.mutationPayloads,
      blockers: receipt.dryRun.blockers,
    })) {
    throw new RunnerFault("RECONCILE_RECEIPT_PLAN_INVALID");
  }
  if (receipt.apply === null || typeof receipt.apply !== "object" || !Array.isArray(receipt.apply.ownedResources)) {
    throw new RunnerFault("RECONCILE_RECEIPT_APPLY_INVALID");
  }
  for (const resource of receipt.apply.ownedResources) {
    if (!["TUNNEL", "DNS_CNAME"].includes(resource?.kind)) {
      throw new RunnerFault("RECONCILE_RECEIPT_OWNERSHIP_INVALID");
    }
    cloudflareId(resource.id, `${resource.kind}_RECEIPT_ID`);
    if (typeof resource.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(resource.fingerprint)) {
      throw new RunnerFault("RECONCILE_RECEIPT_OWNERSHIP_INVALID");
    }
  }
  const kinds = receipt.apply.ownedResources.map((item) => item.kind);
  if (new Set(kinds).size !== kinds.length || receipt.apply.ownedResources.length > 2) {
    throw new RunnerFault("RECONCILE_RECEIPT_OWNERSHIP_INVALID");
  }
  if (receipt.apply.status === "APPLIED") {
    const tunnel = receipt.apply.ownedResources.find((item) => item.kind === "TUNNEL");
    const dns = receipt.apply.ownedResources.find((item) => item.kind === "DNS_CNAME");
    if (receipt.zone.status !== "ACTIVE"
      || receipt.dryRun.executable !== true
      || receipt.dryRun.mutationCount !== 3
      || receipt.dryRun.createCount !== 2
      || receipt.apply.checkpoint !== "COMPLETE"
      || receipt.apply.confirmationStatus !== "CONSUMED"
      || receipt.apply.confirmationHash !== receipt.dryRun.planHash
      || tunnel === undefined
      || dns === undefined
      || !Array.isArray(receipt.apply.changes)
      || receipt.apply.changes.length !== 3
      || receipt.apply.changes[0]?.action !== "CREATED"
      || receipt.apply.changes[0]?.resource !== "TUNNEL"
      || receipt.apply.changes[0]?.id !== tunnel.id
      || receipt.apply.changes[1]?.action !== "CONFIGURED"
      || receipt.apply.changes[1]?.resource !== "TUNNEL_INGRESS"
      || receipt.apply.changes[1]?.id !== tunnel.id
      || receipt.apply.changes[2]?.action !== "CREATED"
      || receipt.apply.changes[2]?.resource !== "DNS_CNAME"
      || receipt.apply.changes[2]?.id !== dns.id) {
      throw new RunnerFault("RECONCILE_RECEIPT_APPLY_INVALID");
    }
  }
  const terminalCleanupClaimed = receipt.status === "PASS"
    || receipt.decision === "CLEANUP_COMPLETE"
    || receipt.cleanup?.status === "PASS"
    || receipt.cleanup?.checkpoint === "COMPLETE";
  if (terminalCleanupClaimed) {
    const ownership = partialOwnershipFromApply(receipt);
    const deleted = Array.isArray(receipt.cleanup?.deletedResources)
      ? receipt.cleanup.deletedResources
      : [];
    const deletedDns = deleted.filter((item) => item?.kind === "DNS_CNAME");
    const deletedTunnels = deleted.filter((item) => item?.kind === "TUNNEL");
    if (receipt.mode !== "RECONCILE"
      || receipt.readOnly !== false
      || receipt.status !== "PASS"
      || receipt.decision !== "CLEANUP_COMPLETE"
      || receipt.reason !== "API_RESOURCE_LIFECYCLE_VERIFIED"
      || receipt.credentialVerified !== true
      || receipt.failure !== null
      || receipt.secretScan?.status !== "PASS"
      || receipt.secondRun?.attempted !== true
      || receipt.secondRun?.status !== "PASS"
      || receipt.secondRun?.duplicateCreates !== 0
      || receipt.secondRun?.ownedTunnelMatched !== true
      || receipt.secondRun?.ownedDnsMatched !== true
      || receipt.secondRun?.ingressMatched !== true
      || receipt.secondRun?.mutationDelta !== 0
      || receipt.cleanup?.attempted !== true
      || receipt.cleanup?.confirmationStatus !== "CONSUMED"
      || receipt.cleanup?.confirmationHash !== operationConfirmationHash("CLEANUP", receipt)
      || receipt.cleanup?.status !== "PASS"
      || receipt.cleanup?.checkpoint !== "COMPLETE"
      || ownership.tunnel === undefined
      || ownership.dns === undefined
      || deleted.length !== 2
      || deletedDns.length !== 1
      || deletedDns[0].id !== ownership.dns.id
      || deletedTunnels.length !== 1
      || deletedTunnels[0].id !== ownership.tunnel.id) {
      throw new RunnerFault("RECONCILE_RECEIPT_TERMINAL_STATE_INVALID");
    }
  }
  return receipt;
}

function makeReconcileEvidence(receipt, { clock, requestLog }) {
  const evidence = structuredClone(receipt);
  const completedCleanup = receipt.cleanup?.status === "PASS"
    && receipt.cleanup?.checkpoint === "COMPLETE";
  const preserveStoppedCleanup = receipt.cleanup?.status === "STOPPED"
    && (receipt.cleanup.deletedResources?.length > 0
      || ["AFTER_DNS_DELETE", "BEFORE_TUNNEL_DELETE", "AFTER_TUNNEL_DELETE"].includes(receipt.cleanup.checkpoint));
  const unresolvedCleanup = (["OUTCOME_UNKNOWN", "IN_PROGRESS"].includes(receipt.cleanup?.status)
    || preserveStoppedCleanup)
    ? structuredClone(receipt.cleanup)
    : null;
  evidence.generatedAt = isoNow(clock);
  evidence.mode = "RECONCILE";
  evidence.readOnly = true;
  evidence.reconcileZone = null;
  evidence.reconcileDnsInspection = null;
  evidence.reconcileTunnelInspection = null;
  evidence.status = "NEEDS_HUMAN_CHECKPOINT";
  evidence.decision = "STOP";
  evidence.reason = "RUNNING";
  evidence.credentialVerified = false;
  evidence.secondRun = completedCleanup
    ? structuredClone(receipt.secondRun)
    : {
        attempted: true,
        status: "NOT_REQUESTED",
        duplicateCreates: null,
        ownedTunnelMatched: null,
        ownedDnsMatched: null,
        ingressMatched: null,
        mutationDelta: null,
      };
  evidence.cleanup = completedCleanup
    ? structuredClone(receipt.cleanup)
    : unresolvedCleanup ?? {
        attempted: false,
        confirmationStatus: "NOT_REQUESTED",
        confirmationHash: null,
        status: "NOT_REQUESTED",
        checkpoint: "NOT_STARTED",
        deletedResources: [],
      };
  evidence.apiRequests = requestLog;
  evidence.failure = null;
  evidence.secretScan = null;
  return evidence;
}

function assertCreatedTunnel(record, desiredName) {
  let id;
  try {
    id = cloudflareId(record?.id, "TUNNEL_ID");
  } catch {
    throw new RunnerFault("CREATED_TUNNEL_RESPONSE_MISMATCH", "NEEDS_HUMAN_CHECKPOINT", {
      outcomeUnknown: true,
    });
  }
  if (record?.name !== desiredName) {
    throw new RunnerFault("CREATED_TUNNEL_RESPONSE_MISMATCH", "NEEDS_HUMAN_CHECKPOINT", {
      outcomeUnknown: true,
    });
  }
  return { ...record, id, name: desiredName };
}

function assertCreatedDns(record, tunnelId, hostname = FIXED_HOSTNAME) {
  let id;
  try {
    id = cloudflareId(record?.id, "DNS_ID");
  } catch {
    throw new RunnerFault("CREATED_DNS_RESPONSE_MISMATCH", "NEEDS_HUMAN_CHECKPOINT", {
      outcomeUnknown: true,
    });
  }
  const expectedContent = `${tunnelId}.cfargotunnel.com`;
  if (record?.type !== "CNAME"
    || record?.name !== hostname
    || record?.content !== expectedContent
    || record?.proxied !== true
    || Number(record?.ttl) !== 1) {
    throw new RunnerFault("CREATED_DNS_RESPONSE_MISMATCH", "NEEDS_HUMAN_CHECKPOINT", {
      outcomeUnknown: true,
    });
  }
  return { ...record, id, type: "CNAME", name: hostname, content: expectedContent };
}

function configuredId(value, field) {
  if (value === null) return null;
  return cloudflareId(value, field);
}

export async function runCloudflareE2E(input = {}) {
  const clock = input.clock ?? (() => new Date());
  const bytes = input.randomBytes ?? randomBytes;
  const mode = input.mode ?? "PREFLIGHT";
  if (mode === "RECONCILE" && input.sessionId === undefined) {
    throw new RunnerFault("RECONCILE_SESSION_REQUIRED");
  }
  const id = checkedSessionId(input.sessionId ?? sessionId(clock, bytes));
  const desiredTunnelName = `${TUNNEL_PREFIX}${id}`;
  const requestLog = [];
  const options = {
    manifestPath: input.manifestPath ?? DEFAULT_MANIFEST_PATH,
    manifestSchemaPath: input.manifestSchemaPath ?? DEFAULT_MANIFEST_SCHEMA_PATH,
    evidenceSchemaPath: DEFAULT_EVIDENCE_SCHEMA_PATH,
    evidenceDirectory: input.evidenceDirectory ?? DEFAULT_EVIDENCE_DIRECTORY,
    writeEvidence: input.writeEvidence,
  };
  let evidence = makeBaseEvidence({
    clock,
    id,
    mode,
    credentialType: "UNKNOWN",
  });
  evidence.apiRequests = requestLog;
  let sensitiveValues = [];
  let reconcileReceiptLoaded = false;

  try {
    if (!["PREFLIGHT", "APPLY", "RECONCILE"].includes(mode)) throw new RunnerFault("RUN_MODE_INVALID");
    if (input.cleanupAfterVerify === true && mode !== "RECONCILE") {
      throw new RunnerFault("CLEANUP_REQUIRES_RECONCILE_MODE");
    }
    if (mode === "RECONCILE") {
      const receipt = validateReconcileReceipt(await loadReceipt(options, id), id);
      evidence = makeReconcileEvidence(receipt, {
        clock,
        requestLog,
      });
      reconcileReceiptLoaded = true;
    }
    const [manifestDocument, manifestSchema] = await Promise.all([
      input.manifest ?? loadManifest(options.manifestPath),
      input.manifestSchema ?? loadManifestSchema(options.manifestSchemaPath),
    ]);
    const { cloudflare, credentialType } = validateManifest(manifestDocument, manifestSchema);
    evidence.credentialType = credentialType;

    const credentialResolution = resolveCredentialFromEnvironment(cloudflare, input.environment ?? process.env);
    sensitiveValues = credentialResolution.sensitiveValues;
    if (mode === "RECONCILE" && scanSanitizedEvidence(evidence, sensitiveValues).status !== "PASS") {
      throw new RunnerFault("RECONCILE_RECEIPT_SECRET_SCAN_FAILED");
    }
    if (credentialResolution.checkpoint !== undefined) {
      evidence.status = "NEEDS_HUMAN_CHECKPOINT";
      evidence.reason = credentialResolution.checkpoint;
      evidence.decision = "STOP";
      return await finalizeEvidence(evidence, sensitiveValues, options);
    }

    const client = createCloudflareClient({
      credential: credentialResolution.credential,
      fetchImplementation: input.fetch ?? globalThis.fetch,
      requestLog,
      sleep: input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    });
    await client.verifyCredential();
    evidence.credentialVerified = true;

    const configuredZoneId = configuredId(cloudflare.zoneId, "CONFIGURED_ZONE_ID");
    const configuredAccountId = configuredId(cloudflare.accountId, "CONFIGURED_ACCOUNT_ID");
    if (mode === "RECONCILE") {
      const actualHostname = evidence.target.hostname;
      const receiptZoneId = evidence.zone.id;
      const receiptAccountId = evidence.zone.accountId;
      if ((configuredZoneId !== null && configuredZoneId !== receiptZoneId)
        || (configuredAccountId !== null && configuredAccountId !== receiptAccountId)) {
        throw new RunnerFault("CONFIGURED_ID_MISMATCH_WITH_RECEIPT");
      }
      const ownership = ownershipFromApply(evidence);
      if (evidence.cleanup.status === "PASS" && evidence.cleanup.checkpoint === "COMPLETE") {
        const inspection = await inspectTarget({
          client,
          configuredZoneId: receiptZoneId,
          configuredAccountId: receiptAccountId,
          desiredTunnelName,
          ownership,
          hostname: actualHostname,
        });
        evidence.reconcileZone = inspection.zone;
        evidence.reconcileDnsInspection = inspection.dns;
        evidence.reconcileTunnelInspection = inspection.tunnels;
        evidence.secondRun.mutationDelta = requestLog.filter((entry) => entry.method !== "GET").length;
        const receiptTunnel = ownership?.tunnel;
        const receiptDns = ownership?.dns;
        const cleanupStillComplete = inspection.zone?.status === "ACTIVE"
          && receiptTunnel !== undefined
          && receiptDns !== undefined
          && !inspection.raw.tunnels.some((item) => item.id === receiptTunnel.id)
          && !inspection.raw.dns.some((item) => item.id === receiptDns.id)
          && evidence.secondRun.mutationDelta === 0;
        if (cleanupStillComplete) {
          evidence.status = "PASS";
          evidence.decision = "CLEANUP_COMPLETE";
          evidence.reason = "API_RESOURCE_LIFECYCLE_VERIFIED";
          return await finalizeEvidence(evidence, sensitiveValues, options);
        }
        evidence.status = "FAIL";
        evidence.decision = "STOP";
        evidence.reason = "COMPLETED_CLEANUP_REVERIFICATION_FAILED";
        return await finalizeEvidence(evidence, sensitiveValues, { ...options, writeEvidence: false });
      }
      if (evidence.apply.status !== "APPLIED" || evidence.apply.checkpoint !== "COMPLETE" || ownership === null) {
        const inspection = await inspectTarget({
          client,
          configuredZoneId: receiptZoneId,
          configuredAccountId: receiptAccountId,
          desiredTunnelName,
          ownership: partialOwnershipFromApply(evidence),
          hostname: actualHostname,
        });
        evidence.reconcileZone = inspection.zone;
        evidence.reconcileDnsInspection = inspection.dns;
        evidence.reconcileTunnelInspection = inspection.tunnels;
        const partialTunnel = inspection.raw.tunnels.find((item) => item.owned);
        evidence.secondRun.ownedTunnelMatched = partialTunnel !== undefined;
        evidence.secondRun.ownedDnsMatched = inspection.raw.dns.some((item) => item.owned);
        const partialConfig = partialTunnel === undefined
          ? null
          : await client.readTunnelConfig(inspection.zone.accountId, partialTunnel.id);
        evidence.secondRun.ingressMatched = partialTunnel === undefined
          ? false
          : tunnelConfigsEqual(partialConfig, expectedIngress(actualHostname));
        evidence.secondRun.duplicateCreates = null;
        evidence.secondRun.status = "FAIL";
        evidence.secondRun.mutationDelta = requestLog.filter((entry) => entry.method !== "GET").length;
        const pendingMutation = evidence.apply.status === "OUTCOME_UNKNOWN"
          || (evidence.apply.status === "IN_PROGRESS"
            && typeof evidence.apply.checkpoint === "string"
            && evidence.apply.checkpoint.startsWith("BEFORE_"));
        evidence.status = "NEEDS_HUMAN_CHECKPOINT";
        evidence.decision = pendingMutation ? "RECONCILE_REQUIRED" : "STOP";
        evidence.reason = pendingMutation ? "OUTCOME_UNKNOWN" : "RECONCILE_RECEIPT_INCOMPLETE";
        return await finalizeEvidence(evidence, sensitiveValues, options);
      }

      const inspection = await inspectTarget({
        client,
        configuredZoneId: receiptZoneId,
        configuredAccountId: receiptAccountId,
        desiredTunnelName,
        ownership,
        hostname: actualHostname,
      });
      evidence.reconcileZone = inspection.zone;
      evidence.reconcileDnsInspection = inspection.dns;
      evidence.reconcileTunnelInspection = inspection.tunnels;
      const secondPlan = buildDryRun(inspection, desiredTunnelName, ownership, actualHostname);
      const tunnel = inspection.raw.tunnels.find((item) => item.owned);
      const dns = inspection.raw.dns.find((item) => item.owned);
      const ingress = expectedIngress(actualHostname);
      const config = tunnel === undefined
        ? null
        : await client.readTunnelConfig(inspection.zone.accountId, tunnel.id);
      evidence.secondRun.duplicateCreates = secondPlan.createCount;
      evidence.secondRun.ownedTunnelMatched = tunnel !== undefined;
      evidence.secondRun.ownedDnsMatched = dns !== undefined;
      evidence.secondRun.ingressMatched = tunnelConfigsEqual(config, ingress);
      evidence.secondRun.mutationDelta = requestLog.filter((entry) => entry.method !== "GET").length;
      const ownedSemanticsMatched = ownedResourceSemanticsMatch({
        tunnel,
        dns,
        desiredTunnelName,
        hostname: actualHostname,
      });
      evidence.secondRun.status = evidence.secondRun.duplicateCreates === 0
        && secondPlan.executable
        && inspection.zone?.status === "ACTIVE"
        && evidence.secondRun.ownedTunnelMatched
        && evidence.secondRun.ownedDnsMatched
        && evidence.secondRun.ingressMatched
        && ownedSemanticsMatched
        && evidence.secondRun.mutationDelta === 0
        && inspection.dns?.collision === false
        && inspection.tunnels?.desiredCollision === false
        ? "PASS"
        : "FAIL";
      if (["OUTCOME_UNKNOWN", "IN_PROGRESS"].includes(evidence.cleanup.status)) {
        evidence.status = "NEEDS_HUMAN_CHECKPOINT";
        evidence.decision = "RECONCILE_REQUIRED";
        evidence.reason = "OUTCOME_UNKNOWN";
        return await finalizeEvidence(evidence, sensitiveValues, options);
      }
      if (evidence.cleanup.status === "STOPPED") {
        evidence.status = "NEEDS_HUMAN_CHECKPOINT";
        evidence.decision = "RECONCILE_REQUIRED";
        evidence.reason = "PARTIAL_CLEANUP_REQUIRES_MANUAL_RECONCILE";
        return await finalizeEvidence(evidence, sensitiveValues, options);
      }
      if (evidence.secondRun.status !== "PASS") {
        throw new RunnerFault("SECOND_RUN_IDEMPOTENCY_FAILED");
      }

      if (input.cleanupAfterVerify !== true) {
        evidence.status = "NEEDS_HUMAN_CHECKPOINT";
        evidence.decision = "APPLY_COMPLETE";
        evidence.reason = "OWNED_CLEANUP_PENDING";
        return await finalizeEvidence(evidence, sensitiveValues, options);
      }

      evidence.cleanup.attempted = true;
      evidence.cleanup.confirmationStatus = "REQUIRED";
      const channel = input.confirmationChannel ?? interactiveConfirmationChannel();
      const cleanupConfirmed = await consumeConfirmation({
        operation: "CLEANUP",
        evidence,
        channel,
        bytes,
        consumed: new Set(),
      });
      if (!cleanupConfirmed) {
        evidence.status = "NEEDS_HUMAN_CHECKPOINT";
        evidence.decision = "APPLY_COMPLETE";
        evidence.reason = "CHECKPOINT_OWNED_CLEANUP";
        return await finalizeEvidence(evidence, sensitiveValues, options);
      }
      evidence.cleanup.confirmationStatus = "CONSUMED";
      evidence.cleanup.status = "IN_PROGRESS";

      const cleanupInspection = await inspectTarget({
        client,
        configuredZoneId: receiptZoneId,
        configuredAccountId: receiptAccountId,
        desiredTunnelName,
        ownership,
        hostname: actualHostname,
      });
      const ownedDns = cleanupInspection.raw.dns.find((item) => item.owned);
      const ownedTunnel = cleanupInspection.raw.tunnels.find((item) => item.owned);
      if (cleanupInspection.zone?.id !== evidence.zone.id
        || cleanupInspection.zone?.accountId !== evidence.zone.accountId
        || cleanupInspection.zone?.status !== "ACTIVE") {
        throw new RunnerFault("TARGET_CHANGED_AFTER_CLEANUP_CONFIRMATION", "NEEDS_HUMAN_CHECKPOINT");
      }
      if (!ownedResourceSemanticsMatch({
        tunnel: ownedTunnel,
        dns: ownedDns,
        desiredTunnelName,
        hostname: actualHostname,
      })) {
        throw new RunnerFault("OWNED_RESOURCE_FINGERPRINT_CHANGED", "NEEDS_HUMAN_CHECKPOINT");
      }
      const cleanupConfig = await client.readTunnelConfig(cleanupInspection.zone.accountId, ownedTunnel.id);
      if (!tunnelConfigsEqual(cleanupConfig, ingress)) {
        throw new RunnerFault("OWNED_INGRESS_FINGERPRINT_CHANGED", "NEEDS_HUMAN_CHECKPOINT");
      }
      evidence.readOnly = false;
      evidence.cleanup.checkpoint = "BEFORE_DNS_DELETE";
      await persistMutationCheckpoint(evidence, sensitiveValues, options);
      await client.deleteDns(cleanupInspection.zone.id, ownedDns.id);
      evidence.cleanup.deletedResources.push({ kind: "DNS_CNAME", id: ownedDns.id });
      evidence.cleanup.checkpoint = "AFTER_DNS_DELETE";
      await persistMutationCheckpoint(evidence, sensitiveValues, options);

      const tunnelDeleteInspection = await inspectTarget({
        client,
        configuredZoneId: receiptZoneId,
        configuredAccountId: receiptAccountId,
        desiredTunnelName,
        ownership,
        hostname: actualHostname,
      });
      const tunnelBeforeDelete = tunnelDeleteInspection.raw.tunnels.find((item) => item.owned);
      if (tunnelDeleteInspection.zone?.id !== evidence.zone.id
        || tunnelDeleteInspection.zone?.accountId !== evidence.zone.accountId
        || tunnelDeleteInspection.zone?.status !== "ACTIVE"
        || tunnelDeleteInspection.raw.dns.length !== 0
        || !ownedTunnelSemanticsMatch(tunnelBeforeDelete, desiredTunnelName)) {
        throw new RunnerFault("TARGET_CHANGED_BEFORE_TUNNEL_DELETE", "NEEDS_HUMAN_CHECKPOINT");
      }
      const tunnelConfigBeforeDelete = await client.readTunnelConfig(
        tunnelDeleteInspection.zone.accountId,
        tunnelBeforeDelete.id,
      );
      if (!tunnelConfigsEqual(tunnelConfigBeforeDelete, ingress)) {
        throw new RunnerFault("OWNED_INGRESS_FINGERPRINT_CHANGED", "NEEDS_HUMAN_CHECKPOINT");
      }
      evidence.cleanup.checkpoint = "BEFORE_TUNNEL_DELETE";
      await persistMutationCheckpoint(evidence, sensitiveValues, options);
      await client.deleteTunnel(tunnelDeleteInspection.zone.accountId, tunnelBeforeDelete.id);
      evidence.cleanup.deletedResources.push({ kind: "TUNNEL", id: tunnelBeforeDelete.id });
      evidence.cleanup.checkpoint = "AFTER_TUNNEL_DELETE";
      await persistMutationCheckpoint(evidence, sensitiveValues, options);

      const [dnsAfterCleanup, tunnelsAfterCleanup] = await Promise.all([
        client.listDns(cleanupInspection.zone.id, actualHostname),
        client.listTunnels(cleanupInspection.zone.accountId),
      ]);
      const cleanupVerified = !dnsAfterCleanup.some((item) => item?.id === ownedDns.id)
        && !tunnelsAfterCleanup.some((item) => item?.id === tunnelBeforeDelete.id);
      evidence.cleanup.status = cleanupVerified ? "PASS" : "FAIL";
      if (!cleanupVerified) throw new RunnerFault("OWNED_CLEANUP_VERIFICATION_FAILED");
      evidence.cleanup.checkpoint = "COMPLETE";
      evidence.status = "PASS";
      evidence.decision = "CLEANUP_COMPLETE";
      evidence.reason = "API_RESOURCE_LIFECYCLE_VERIFIED";
      return await finalizeEvidence(evidence, sensitiveValues, options);
    }

    let actualHostname = FIXED_HOSTNAME;
    let inspection = await inspectTarget({
      client,
      configuredZoneId,
      configuredAccountId,
      desiredTunnelName,
      ownership: null,
      hostname: actualHostname,
    });
    if (inspection.zone?.status === "ACTIVE" && inspection.dns?.collision === true) {
      actualHostname = `mcp-e2e-${id}.${FIXED_ZONE}`;
      evidence.target.hostname = actualHostname;
      evidence.target.hostnameSelection = "SESSION_FALLBACK";
      inspection = await inspectTarget({
        client,
        configuredZoneId,
        configuredAccountId,
        desiredTunnelName,
        ownership: null,
        hostname: actualHostname,
      });
    }
    evidence.zone = inspection.zone;
    evidence.dnsInspection = inspection.dns;
    evidence.tunnelInspection = inspection.tunnels;
    evidence.dryRun = buildDryRun(inspection, desiredTunnelName, null, actualHostname);

    if (inspection.zone === null) {
      evidence.status = "NEEDS_HUMAN_CHECKPOINT";
      evidence.reason = "ZONE_NOT_FOUND";
      return await finalizeEvidence(evidence, sensitiveValues, options);
    }
    if (inspection.zone.status !== "ACTIVE") {
      evidence.status = "NEEDS_HUMAN_CHECKPOINT";
      evidence.reason = "ZONE_NOT_ACTIVE";
      return await finalizeEvidence(evidence, sensitiveValues, options);
    }
    if (!evidence.dryRun.executable) {
      evidence.status = "NEEDS_HUMAN_CHECKPOINT";
      evidence.reason = "UNKNOWN_RESOURCE_COLLISION";
      return await finalizeEvidence(evidence, sensitiveValues, options);
    }
    if (mode === "PREFLIGHT") {
      evidence.status = "NEEDS_HUMAN_CHECKPOINT";
      evidence.decision = "DRY_RUN_READY";
      evidence.reason = "CHECKPOINT_CLOUDFLARE_APPLY";
      return await finalizeEvidence(evidence, sensitiveValues, options);
    }

    evidence.apply.attempted = true;
    evidence.apply.confirmationStatus = "REQUIRED";
    if (input.enableApply !== true) {
      evidence.status = "NEEDS_HUMAN_CHECKPOINT";
      evidence.reason = "APPLY_DISABLED_BY_DEFAULT";
      return await finalizeEvidence(evidence, sensitiveValues, options);
    }
    const channel = input.confirmationChannel ?? interactiveConfirmationChannel();
    const consumed = new Set();
    const confirmed = await consumeConfirmation({ operation: "APPLY", evidence, channel, bytes, consumed });
    if (!confirmed) {
      evidence.status = "NEEDS_HUMAN_CHECKPOINT";
      evidence.reason = "CHECKPOINT_CLOUDFLARE_APPLY";
      return await finalizeEvidence(evidence, sensitiveValues, options);
    }
    evidence.apply.confirmationStatus = "CONSUMED";
    evidence.apply.confirmationHash = evidence.dryRun.planHash;
    evidence.apply.status = "IN_PROGRESS";

    // Re-read every target immediately before the first mutation to close the Dry Run race window.
    inspection = await inspectTarget({
      client,
      configuredZoneId,
      configuredAccountId,
      desiredTunnelName,
      ownership: null,
      hostname: actualHostname,
    });
    const racePlan = buildDryRun(inspection, desiredTunnelName, null, actualHostname);
    if (!racePlan.executable || inspection.zone?.status !== "ACTIVE"
      || racePlan.planHash !== evidence.dryRun.planHash) {
      throw new RunnerFault("TARGET_CHANGED_AFTER_CONFIRMATION", "NEEDS_HUMAN_CHECKPOINT");
    }

    const accountId = inspection.zone.accountId;
    const zoneId = inspection.zone.id;
    evidence.apply.checkpoint = "BEFORE_TUNNEL_CREATE";
    await persistMutationCheckpoint(evidence, sensitiveValues, options);
    const tunnel = assertCreatedTunnel(await client.createTunnel(accountId, desiredTunnelName), desiredTunnelName);
    evidence.apply.changes.push({ action: "CREATED", resource: "TUNNEL", id: tunnel.id });
    evidence.apply.ownedResources.push(applyOwnedResource("TUNNEL", tunnel, accountId));
    evidence.apply.checkpoint = "AFTER_TUNNEL_CREATE";
    await persistMutationCheckpoint(evidence, sensitiveValues, options);

    const ingress = expectedIngress(actualHostname);
    evidence.apply.checkpoint = "BEFORE_INGRESS_CONFIGURE";
    await persistMutationCheckpoint(evidence, sensitiveValues, options);
    const appliedConfig = await client.updateTunnelConfig(accountId, tunnel.id, ingress);
    if (!tunnelConfigsEqual(appliedConfig, ingress)) {
      throw new RunnerFault("TUNNEL_CONFIG_RESPONSE_MISMATCH", "NEEDS_HUMAN_CHECKPOINT", {
        outcomeUnknown: true,
      });
    }
    evidence.apply.changes.push({ action: "CONFIGURED", resource: "TUNNEL_INGRESS", id: tunnel.id });
    evidence.apply.checkpoint = "AFTER_INGRESS_CONFIGURE";
    await persistMutationCheckpoint(evidence, sensitiveValues, options);

    const dnsBeforeCreate = await client.listDns(zoneId, actualHostname);
    if (dnsBeforeCreate.length !== 0) {
      throw new RunnerFault("DNS_CHANGED_AFTER_CONFIRMATION", "NEEDS_HUMAN_CHECKPOINT");
    }
    const dnsInput = {
      type: "CNAME",
      name: actualHostname,
      content: `${tunnel.id}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
    };
    evidence.apply.checkpoint = "BEFORE_DNS_CREATE";
    await persistMutationCheckpoint(evidence, sensitiveValues, options);
    const dns = assertCreatedDns(await client.createDns(zoneId, dnsInput), tunnel.id, actualHostname);
    evidence.apply.changes.push({ action: "CREATED", resource: "DNS_CNAME", id: dns.id });
    evidence.apply.ownedResources.push(applyOwnedResource("DNS_CNAME", dns, zoneId));
    evidence.apply.checkpoint = "AFTER_DNS_CREATE";
    await persistMutationCheckpoint(evidence, sensitiveValues, options);
    evidence.apply.status = "APPLIED";
    evidence.apply.checkpoint = "COMPLETE";
    await persistMutationCheckpoint(evidence, sensitiveValues, options);
    evidence.status = "NEEDS_HUMAN_CHECKPOINT";
    evidence.decision = "RECONCILE_REQUIRED";
    evidence.reason = "SECOND_INVOCATION_REQUIRED";
    return await finalizeEvidence(evidence, sensitiveValues, options);
  } catch (error) {
    if (error instanceof RunnerFault && error.outcomeUnknown) {
      if (evidence.cleanup.status === "IN_PROGRESS") {
        evidence.cleanup.status = "OUTCOME_UNKNOWN";
        evidence.cleanup.checkpoint = "OUTCOME_UNKNOWN";
      } else {
        evidence.apply.status = "OUTCOME_UNKNOWN";
        evidence.apply.checkpoint = "OUTCOME_UNKNOWN";
      }
      setFaultEvidence(evidence, new RunnerFault("OUTCOME_UNKNOWN", "NEEDS_HUMAN_CHECKPOINT"));
      evidence.decision = "RECONCILE_REQUIRED";
    } else {
      setFaultEvidence(evidence, error);
    }
    return await finalizeEvidence(
      evidence,
      sensitiveValues,
      mode === "RECONCILE" && !reconcileReceiptLoaded
        ? { ...options, writeEvidence: false }
        : options,
    );
  } finally {
    sensitiveValues.fill("");
  }
}

export function cloudflareE2EExitCode(evidence) {
  if (evidence?.status === "PASS") return 0;
  if (evidence?.status === "FAIL") return 1;
  if (["BLOCKED_BY_ENVIRONMENT", "BLOCKED_BY_EXTERNAL_ACCOUNT"].includes(evidence?.status)) return 2;
  if (evidence?.status === "NEEDS_HUMAN_CHECKPOINT") return 3;
  return 1;
}

function parseArguments(arguments_) {
  let mode = "PREFLIGHT";
  let cleanupAfterVerify = false;
  let explicitMode = false;
  let reconcileSessionId;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--preflight" || argument === "--apply") {
      if (explicitMode) throw new RunnerFault("COMMAND_LINE_MODE_CONFLICT");
      mode = argument === "--preflight" ? "PREFLIGHT" : "APPLY";
      explicitMode = true;
    } else if (argument === "--reconcile") {
      if (explicitMode) throw new RunnerFault("COMMAND_LINE_MODE_CONFLICT");
      const candidate = arguments_[index + 1];
      if (candidate === undefined || candidate.startsWith("--")) {
        throw new RunnerFault("RECONCILE_SESSION_REQUIRED");
      }
      reconcileSessionId = checkedSessionId(candidate);
      mode = "RECONCILE";
      explicitMode = true;
      index += 1;
    }
    else if (argument === "--cleanup-after-verify") cleanupAfterVerify = true;
    else throw new RunnerFault("COMMAND_LINE_ARGUMENT_REJECTED");
  }
  if (cleanupAfterVerify && mode !== "RECONCILE") {
    throw new RunnerFault("CLEANUP_REQUIRES_RECONCILE_MODE");
  }
  return {
    mode,
    cleanupAfterVerify,
    ...(reconcileSessionId === undefined ? {} : { sessionId: reconcileSessionId }),
  };
}

async function main() {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (error) {
    const failure = safeFailure(error);
    process.stdout.write(`${JSON.stringify({ status: failure.classification, reason: failure.code }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const result = await runCloudflareE2E({
    ...parsed,
    enableApply: process.env.TOOLSPAN_E2E_ENABLE_APPLY === "1",
  });
  const relativeEvidencePath = result.evidencePath === null
    ? null
    : path.relative(PROJECT_ROOT, result.evidencePath).replaceAll("\\", "/");
  process.stdout.write(`${JSON.stringify({ ...result.evidence, evidenceFile: relativeEvidencePath }, null, 2)}\n`);
  process.exitCode = cloudflareE2EExitCode(result.evidence);
}

const invokedPath = process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) await main();
