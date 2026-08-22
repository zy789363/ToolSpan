import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isDirectory, isFile, projectRoot } from "./desktop-verification-utils.mjs";

const TEXT_EXTENSIONS = new Set([".json", ".md", ".mjs", ".ps1", ".rs", ".ts", ".tsx"]);
const IGNORED_DIRECTORIES = new Set([".git", ".toolspan-dev", "dist", "node_modules", "target", "vendor-inputs"]);
const SELECTED_ROOTS = [
  "src/setup",
  "apps/desktop/src",
  "apps/desktop/src-tauri/src",
  "schemas",
  "config",
  "docs/setup",
  "docs/prompts",
  "examples",
];
const SECRET_VALUE_EXCLUDED_PATH_CLASSES = ["tests", "fixtures", "__tests__", "*.spec.*", "*.test.*"];
const TEST_ENVIRONMENT_SECRET_ENV_NAMES = new Set([
  "TOOLSPAN_E2E_CF_API_TOKEN",
  "TOOLSPAN_E2E_CF_GLOBAL_EMAIL",
  "CloudFlareAPIKEY",
]);
const SECRET_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*|\bsk-[A-Za-z0-9_-]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[baprs]-[A-Za-z0-9-]{20,}|\b(?:CloudFlareAPIKEY|CLOUDFLARE_(?:API_TOKEN|GLOBAL_API_KEY)|TOOLSPAN_E2E_CF_(?:API_TOKEN|GLOBAL_KEY))\s*[=:]\s*["']?[A-Za-z0-9._~+/-]{20,})/iu;
const FORBIDDEN_DURABLE_FIELD = /^(?:apiToken|globalApiKey|apiKey|authorization|managementCredential|credentialValue|ownerPassword|ownerHash|tunnelToken|tunnelCredential)$/iu;
const FORBIDDEN_SHELL = /(?:shell\s*:\s*true|@tauri-apps\/plugin-shell|tauri-plugin-shell|(?:Command::new|spawn)\s*\(\s*["'`](?:cmd|powershell|pwsh|bash|zsh)(?:\.exe)?["'`]|(?:ba)?sh\s+-c\b)/iu;
const CREDENTIAL_COMMAND_LINE = /(?:spawn|Command::new|\.args?\s*\()[\s\S]{0,400}\b(?:api[_-]?token|global[_-]?(?:api[_-]?)?key|management[_-]?credential|authorization|tunnel[_-]?(?:token|credential))\b/iu;
const SETUP_PATH = /(?:^|\/)(?:src\/setup|docs\/setup|docs\/prompts|config|schemas|examples|apps\/desktop\/src|apps\/desktop\/src-tauri\/src)(?:\/|$)/u;
const PRODUCTION_SOURCE = /^(?:src\/setup|apps\/desktop\/src|apps\/desktop\/src-tauri\/src)\//u;

function normalized(value) {
  return value.replaceAll("\\", "/");
}

function isTestPath(relativePath) {
  return /(?:^|\/)(?:test|tests|__tests__|fixtures)(?:\/|$)|\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(relativePath);
}

async function collectTextFiles(root, base = projectRoot) {
  if (!await isDirectory(root)) return [];
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push({
          relativePath: normalized(path.relative(base, absolutePath)),
          text: await readFile(absolutePath, "utf8"),
        });
      }
    }
  };
  await visit(root);
  return files;
}

function durablePropertyNames(schema) {
  const names = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (value.properties !== null && typeof value.properties === "object" && !Array.isArray(value.properties)) {
      names.push(...Object.keys(value.properties));
    }
    Object.values(value).forEach((item) => visit(item));
  };
  visit(schema);
  return names;
}

function stringsIn(value, pathSegments = [], output = []) {
  if (typeof value === "string") output.push({ path: pathSegments, value });
  else if (Array.isArray(value)) value.forEach((item, index) => stringsIn(item, [...pathSegments, String(index)], output));
  else if (value !== null && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => stringsIn(item, [...pathSegments, key], output));
  }
  return output;
}

export function analyzeTestEnvironmentManifest(document) {
  const violations = [];
  for (const entry of stringsIn(document)) {
    const key = entry.path.at(-1) ?? "";
    if (SECRET_VALUE.test(entry.value)) violations.push("TEST_ENVIRONMENT_SECRET_VALUE");
    if (/(?:Env|EnvironmentVariableName)$/u.test(key)
      && !TEST_ENVIRONMENT_SECRET_ENV_NAMES.has(entry.value)) {
      violations.push("TEST_ENVIRONMENT_INVALID_SECRET_ENV_NAME");
    }
  }
  const forbiddenKeys = [];
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach((item) => visit(item));
    else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (FORBIDDEN_DURABLE_FIELD.test(key)) forbiddenKeys.push(key);
        visit(item);
      }
    }
  };
  visit(document);
  if (forbiddenKeys.length > 0) violations.push("TEST_ENVIRONMENT_SECRET_FIELD");
  return [...new Set(violations)].sort();
}

export function analyzeSetupSecurity(files, documents = {}) {
  const violations = [];
  const add = (code, relativePath) => violations.push({ code, file: normalized(relativePath) });
  const setupFiles = files.filter((file) => SETUP_PATH.test(`/${normalized(file.relativePath)}`));

  for (const file of setupFiles) {
    const relativePath = normalized(file.relativePath);
    if (!isTestPath(relativePath) && SECRET_VALUE.test(file.text)) add("SECRET_VALUE_IN_SETUP_SOURCE", relativePath);
    if (PRODUCTION_SOURCE.test(relativePath) && FORBIDDEN_SHELL.test(file.text)) {
      add("ARBITRARY_SHELL_IN_SETUP_SOURCE", relativePath);
    }
    if (PRODUCTION_SOURCE.test(relativePath) && CREDENTIAL_COMMAND_LINE.test(file.text)) {
      add("CREDENTIAL_ON_PROCESS_COMMAND_LINE", relativePath);
    }
  }

  for (const [relativePath, schema] of Object.entries(documents.durableSchemas ?? {})) {
    for (const name of durablePropertyNames(schema)) {
      if (FORBIDDEN_DURABLE_FIELD.test(name)) add("MANAGEMENT_CREDENTIAL_IN_DURABLE_SCHEMA", relativePath);
    }
  }

  for (const code of analyzeTestEnvironmentManifest(documents.testEnvironment ?? {})) {
    add(code, "examples/test-environment.example.json");
  }

  const setupProductionText = setupFiles
    .filter((file) => PRODUCTION_SOURCE.test(normalized(file.relativePath)))
    .map((file) => file.text)
    .join("\n");
  if (!/https:\/\/api\.cloudflare\.com(?:\/client\/v4)?/u.test(setupProductionText)) {
    add("FIXED_CLOUDFLARE_API_ORIGIN_MISSING", "src/setup");
  }
  if (!/redact(?:ion|ed)?/iu.test(setupProductionText)) add("SETUP_REDACTION_BOUNDARY_MISSING", "src/setup");

  const unique = new Map(violations.map((item) => [`${item.code}:${item.file}`, item]));
  return [...unique.values()].sort((left, right) => `${left.code}:${left.file}`.localeCompare(`${right.code}:${right.file}`));
}

export function createSetupSecurityResult(files, violations, options = {}) {
  const selectedFiles = files.filter((file) => (
    TEXT_EXTENSIONS.has(path.extname(file.relativePath).toLowerCase())
    && SETUP_PATH.test(`/${normalized(file.relativePath)}`)
  ));
  const productionSourceFiles = selectedFiles.filter((file) => PRODUCTION_SOURCE.test(normalized(file.relativePath)));
  const secretValueFiles = selectedFiles.filter((file) => !isTestPath(normalized(file.relativePath)));
  const publicViolations = violations
    .filter((item) => item !== null && typeof item === "object")
    .map((item) => ({ code: String(item.code), file: normalized(String(item.file)) }));
  const scanEvidence = {
    scanScope: {
      roots: [...SELECTED_ROOTS],
      textExtensions: [...TEXT_EXTENSIONS],
      excludedDirectoryNames: [...IGNORED_DIRECTORIES],
      secretValueExcludedPathClasses: [...SECRET_VALUE_EXCLUDED_PATH_CLASSES],
      packagedInputsIncluded: false,
    },
    selectedTextFilesAnalyzed: selectedFiles.length,
    productionSourceTextFilesAnalyzed: productionSourceFiles.length,
    secretValueTextFilesScanned: secretValueFiles.length,
    secretValueTextFilesExcludedAsTests: selectedFiles.length - secretValueFiles.length,
    durableSchemaDocumentsAnalyzed: options.durableSchemaDocumentsAnalyzed ?? 0,
    secretValuePatternFindings: publicViolations.filter((item) => item.code === "SECRET_VALUE_IN_SETUP_SOURCE").length,
  };

  return publicViolations.length === 0
    ? {
        status: "PASS",
        checks: [
          "NO_MANAGEMENT_CREDENTIAL_FIELD_IN_SELECTED_DURABLE_SCHEMAS",
          "NO_CREDENTIAL_COMMAND_LINE_PATTERN_IN_SELECTED_PRODUCTION_SOURCE_TEXT",
          "NO_SECRET_VALUE_PATTERN_IN_SELECTED_NON_TEST_SETUP_TEXT",
          "TEST_ENVIRONMENT_EXAMPLE_ENV_NAMES_ONLY",
          "FIXED_CLOUDFLARE_API_ORIGIN_PATTERN_IN_SELECTED_PRODUCTION_SOURCE_TEXT",
          "SETUP_REDACTION_PATTERN_IN_SELECTED_PRODUCTION_SOURCE_TEXT",
          "NO_ARBITRARY_SHELL_PATTERN_IN_SELECTED_PRODUCTION_SOURCE_TEXT",
        ],
        ...scanEvidence,
      }
    : {
        status: "FAIL",
        reason: "SETUP_SECURITY_BOUNDARY_VIOLATION",
        violations: publicViolations,
        ...scanEvidence,
      };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function checkSetupSecurity() {
  const durableSchemaPaths = [
    "schemas/setup-state.schema.json",
    "schemas/setup-journal.schema.json",
    "schemas/setup-manifest.schema.json",
    "schemas/setup-receipt.schema.json",
    "schemas/setup-safe-manifest.schema.json",
  ];
  const required = [
    path.join(projectRoot, "src", "setup"),
    path.join(projectRoot, "apps", "desktop", "src-tauri", "src", "setup.rs"),
    path.join(projectRoot, "examples", "test-environment.example.json"),
    ...durableSchemaPaths.map((relativePath) => path.join(projectRoot, relativePath)),
  ];
  const requiredResults = await Promise.all(required.map(async (filePath, index) => (
    index === 0 ? await isDirectory(filePath) : await isFile(filePath)
  )));
  if (!requiredResults.every(Boolean)) {
    return { status: "FAIL", reason: "SETUP_SECURITY_INPUT_MISSING", violations: [] };
  }

  const roots = SELECTED_ROOTS.map((relativePath) => path.join(projectRoot, relativePath));
  const fileGroups = await Promise.all(roots.map((root) => collectTextFiles(root)));
  const durableSchemas = Object.fromEntries(await Promise.all(durableSchemaPaths.map(async (relativePath) => [
    relativePath,
    await readJson(path.join(projectRoot, relativePath)),
  ])));
  const testEnvironment = await readJson(path.join(projectRoot, "examples", "test-environment.example.json"));
  const files = fileGroups.flat();
  const violations = analyzeSetupSecurity(files, { durableSchemas, testEnvironment });
  return createSetupSecurityResult(files, violations, {
    durableSchemaDocumentsAnalyzed: Object.keys(durableSchemas).length,
  });
}

async function main() {
  try {
    const result = await checkSetupSecurity();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== "PASS") process.exitCode = 1;
  } catch {
    process.stdout.write(`${JSON.stringify({ status: "FAIL", reason: "SETUP_SECURITY_CHECK_FAILED" })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
