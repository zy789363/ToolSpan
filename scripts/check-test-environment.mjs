import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(scriptDirectory, "..");
export const defaultManifestPath = path.join(projectRoot, ".toolspan-dev", "test-environment.json");
export const defaultSchemaPath = path.join(projectRoot, "schemas", "test-environment.schema.json");

const TOP_LEVEL_KEYS = [
  "schemaVersion", "cloudflare", "browserAutomation", "chatgpt", "windows", "secondaryHost",
];
const NESTED_KEYS = {
  cloudflare: [
    "available", "zoneName", "preferredHostname", "zoneId", "accountId", "zoneStatus",
    "credentialAvailable", "credentialType", "apiTokenEnv", "globalEmailEnv", "globalKeyEnv",
  ],
  browserAutomation: [
    "chromeAuthorized", "computerUseAuthorized", "humanCredentialEntryRequired",
    "humanConsequentialConfirmationRequired",
  ],
  chatgpt: [
    "currentAccountAvailable", "businessWorkspaceRequired", "developerModeVisible",
    "customMcpUiReachable", "writeValidationRequired",
  ],
  windows: ["nativeVmAvailable", "adminRights"],
  secondaryHost: ["name", "available", "writeE2eRequired"],
};
const BOOLEAN_OR_NULL = new Set([true, false, null]);
const ZONE_STATUSES = new Set(["UNKNOWN", "INITIALIZING", "PENDING", "ACTIVE", "MOVED", "NOT_FOUND"]);
const CREDENTIAL_TYPES = new Set(["SCOPED_API_TOKEN", "GLOBAL_API_KEY", "UNKNOWN"]);
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const ENVIRONMENT_REFERENCES = {
  apiTokenEnv: new Set(["TOOLSPAN_E2E_CF_API_TOKEN"]),
  globalEmailEnv: new Set(["TOOLSPAN_E2E_CF_GLOBAL_EMAIL"]),
  globalKeyEnv: new Set(["CloudFlareAPIKEY"]),
};
const CLOUDFLARE_ID = /^[a-f0-9]{32}$/iu;
const SECRET_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{16,}|\bBasic\s+[A-Za-z0-9+/]{20,}=*|\bsk-[A-Za-z0-9_-]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[baprs]-[A-Za-z0-9-]{20,}|\bAIza[0-9A-Za-z_-]{30,}|[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@)/iu;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameStringSet(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function exactKeys(value, expected, location, errors) {
  if (!isObject(value)) {
    errors.push(`${location}:EXPECTED_OBJECT`);
    return false;
  }
  const actual = Object.keys(value);
  for (const key of expected) if (!actual.includes(key)) errors.push(`${location}.${key}:MISSING_FIELD`);
  for (const key of actual) if (!expected.includes(key)) errors.push(`${location}:UNEXPECTED_FIELD`);
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}

function booleanField(value, location, errors) {
  if (typeof value !== "boolean") errors.push(`${location}:EXPECTED_BOOLEAN`);
}

function nullableBooleanField(value, location, errors) {
  if (!BOOLEAN_OR_NULL.has(value)) errors.push(`${location}:EXPECTED_BOOLEAN_OR_NULL`);
}

function environmentReference(value, field, location, errors) {
  if (typeof value !== "string" || !ENVIRONMENT_NAME.test(value)
    || !ENVIRONMENT_REFERENCES[field].has(value)) {
    errors.push(`${location}:EXPECTED_ENVIRONMENT_VARIABLE_NAME`);
  }
}

function secretValueCount(value, location = "testEnvironment") {
  if (typeof value === "string") {
    if (/\.(?:apiTokenEnv|globalEmailEnv|globalKeyEnv)$/u.test(location)) return 0;
    return SECRET_VALUE.test(value) ? 1 : 0;
  }
  if (Array.isArray(value)) return value.reduce((total, item, index) => total + secretValueCount(item, `${location}[${index}]`), 0);
  if (!isObject(value)) return 0;
  return Object.entries(value).reduce(
    (total, [key, child]) => total + secretValueCount(child, `${location}.${key}`),
    0,
  );
}

export function validateTestEnvironmentSchema(schema) {
  const errors = [];
  if (!isObject(schema)) return ["schema:EXPECTED_OBJECT"];
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") errors.push("schema.$schema:EXPECTED_2020_12");
  if (schema.type !== "object" || schema.additionalProperties !== false) errors.push("schema:EXPECTED_CLOSED_OBJECT");
  if (!sameStringSet(schema.required, TOP_LEVEL_KEYS)) errors.push("schema.required:EXPECTED_V2_FIELDS");
  if (!isObject(schema.properties)) return [...errors, "schema.properties:EXPECTED_OBJECT"];
  if (schema.properties.schemaVersion?.const !== "2.0") errors.push("schema.properties.schemaVersion:EXPECTED_2_0");
  for (const [section, keys] of Object.entries(NESTED_KEYS)) {
    const definition = schema.properties[section];
    if (!isObject(definition) || definition.type !== "object" || definition.additionalProperties !== false) {
      errors.push(`schema.properties.${section}:EXPECTED_CLOSED_OBJECT`);
      continue;
    }
    if (!sameStringSet(definition.required, keys)) errors.push(`schema.properties.${section}.required:EXPECTED_V2_FIELDS`);
    if (!isObject(definition.properties)
      || !sameStringSet(Object.keys(definition.properties), keys)) {
      errors.push(`schema.properties.${section}.properties:EXPECTED_V2_FIELDS`);
    }
  }
  return errors;
}

export function analyzeTestEnvironment(manifest, schema) {
  const errors = validateTestEnvironmentSchema(schema);
  if (!exactKeys(manifest, TOP_LEVEL_KEYS, "testEnvironment", errors)) {
    return { errors: [...new Set(errors)], secretValues: secretValueCount(manifest) };
  }

  if (manifest.schemaVersion !== "2.0") errors.push("testEnvironment.schemaVersion:EXPECTED_2_0");
  for (const [section, keys] of Object.entries(NESTED_KEYS)) {
    exactKeys(manifest[section], keys, `testEnvironment.${section}`, errors);
  }
  if (errors.some((error) => error.endsWith("EXPECTED_OBJECT"))) {
    return { errors: [...new Set(errors)], secretValues: secretValueCount(manifest) };
  }

  const cloudflare = manifest.cloudflare;
  booleanField(cloudflare.available, "testEnvironment.cloudflare.available", errors);
  if (cloudflare.zoneName !== "aiqushi.top") errors.push("testEnvironment.cloudflare.zoneName:EXPECTED_OWNER_ZONE");
  if (cloudflare.preferredHostname !== "mcp.aiqushi.top") {
    errors.push("testEnvironment.cloudflare.preferredHostname:EXPECTED_OWNER_HOSTNAME");
  }
  for (const field of ["zoneId", "accountId"]) {
    const value = cloudflare[field];
    if (value !== null && (typeof value !== "string" || !CLOUDFLARE_ID.test(value))) {
      errors.push(`testEnvironment.cloudflare.${field}:EXPECTED_CLOUDFLARE_ID_OR_NULL`);
    }
  }
  if (!ZONE_STATUSES.has(cloudflare.zoneStatus)) errors.push("testEnvironment.cloudflare.zoneStatus:INVALID_STATUS");
  booleanField(cloudflare.credentialAvailable, "testEnvironment.cloudflare.credentialAvailable", errors);
  if (!CREDENTIAL_TYPES.has(cloudflare.credentialType)) {
    errors.push("testEnvironment.cloudflare.credentialType:INVALID_TYPE");
  }
  for (const field of ["apiTokenEnv", "globalEmailEnv", "globalKeyEnv"]) {
    environmentReference(cloudflare[field], field, `testEnvironment.cloudflare.${field}`, errors);
  }

  const browser = manifest.browserAutomation;
  for (const field of NESTED_KEYS.browserAutomation) {
    booleanField(browser[field], `testEnvironment.browserAutomation.${field}`, errors);
  }
  if (browser.chromeAuthorized !== true || browser.computerUseAuthorized !== true) {
    errors.push("testEnvironment.browserAutomation:OWNER_AUTHORIZATION_MUST_BE_RECORDED");
  }
  if (browser.humanCredentialEntryRequired !== true || browser.humanConsequentialConfirmationRequired !== true) {
    errors.push("testEnvironment.browserAutomation:HUMAN_CHECKPOINTS_MUST_REMAIN_REQUIRED");
  }

  const chatgpt = manifest.chatgpt;
  booleanField(chatgpt.currentAccountAvailable, "testEnvironment.chatgpt.currentAccountAvailable", errors);
  booleanField(chatgpt.businessWorkspaceRequired, "testEnvironment.chatgpt.businessWorkspaceRequired", errors);
  nullableBooleanField(chatgpt.developerModeVisible, "testEnvironment.chatgpt.developerModeVisible", errors);
  nullableBooleanField(chatgpt.customMcpUiReachable, "testEnvironment.chatgpt.customMcpUiReachable", errors);
  booleanField(chatgpt.writeValidationRequired, "testEnvironment.chatgpt.writeValidationRequired", errors);
  if (chatgpt.businessWorkspaceRequired !== false || chatgpt.writeValidationRequired !== false) {
    errors.push("testEnvironment.chatgpt:BUSINESS_OR_WRITE_MUST_NOT_BE_RELEASE_REQUIRED");
  }

  const windows = manifest.windows;
  for (const field of NESTED_KEYS.windows) booleanField(windows[field], `testEnvironment.windows.${field}`, errors);

  const host = manifest.secondaryHost;
  if (host.name !== "Codex") errors.push("testEnvironment.secondaryHost.name:EXPECTED_CODEX");
  booleanField(host.available, "testEnvironment.secondaryHost.available", errors);
  booleanField(host.writeE2eRequired, "testEnvironment.secondaryHost.writeE2eRequired", errors);
  if (host.writeE2eRequired !== true) errors.push("testEnvironment.secondaryHost.writeE2eRequired:EXPECTED_TRUE");

  let secretValues = secretValueCount(manifest);
  for (const field of ["apiTokenEnv", "globalEmailEnv", "globalKeyEnv"]) {
    const value = cloudflare[field];
    if (typeof value === "string" && !ENVIRONMENT_REFERENCES[field].has(value) && value.length >= 16) {
      secretValues += 1;
    }
  }
  if (secretValues > 0) errors.push("testEnvironment:SECRET_VALUE_FORBIDDEN");
  return { errors: [...new Set(errors)], secretValues };
}

export async function checkTestEnvironment(options = {}) {
  const manifestPath = options.manifestPath ?? defaultManifestPath;
  const schemaPath = options.schemaPath ?? defaultSchemaPath;
  let manifestText;
  try {
    manifestText = await (options.readFile ?? readFile)(manifestPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        status: "EXTERNAL_GATE_PENDING",
        reason: "TEST_ENVIRONMENT_MANIFEST_MISSING",
        secretValues: null,
        secretScan: "NOT_PERFORMED",
        exitCode: 2,
      };
    }
    throw error;
  }
  const schemaText = await (options.readFile ?? readFile)(schemaPath, "utf8");
  let manifest;
  let schema;
  try {
    manifest = JSON.parse(manifestText);
    schema = JSON.parse(schemaText);
  } catch {
    return {
      status: "FAIL",
      reason: "TEST_ENVIRONMENT_JSON_INVALID",
      secretValues: null,
      secretScan: "NOT_PERFORMED",
      exitCode: 1,
    };
  }
  const analysis = analyzeTestEnvironment(manifest, schema);
  if (analysis.errors.length > 0) {
    return {
      status: "FAIL",
      reason: "TEST_ENVIRONMENT_V2_INVALID",
      findings: analysis.errors,
      secretValues: analysis.secretValues,
      exitCode: 1,
    };
  }
  return {
    status: "PASS",
    schemaVersion: "2.0",
    targetPolicy: "AIQUSHI_TOP_ONLY",
    secretEnvironmentReferences: 3,
    secretValues: 0,
    humanCredentialEntryRequired: true,
    humanConsequentialConfirmationRequired: true,
    exitCode: 0,
  };
}

async function main() {
  try {
    const result = await checkTestEnvironment();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode;
  } catch {
    process.stdout.write(`${JSON.stringify({
      status: "FAIL",
      reason: "TEST_ENVIRONMENT_CHECK_CRASHED",
      secretValues: 0,
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
