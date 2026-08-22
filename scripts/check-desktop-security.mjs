import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { desktopRoot, isDirectory, isFile, projectRoot } from "./desktop-verification-utils.mjs";

const ALLOWED_PROTOCOL_METHODS = new Set([
  "system.hello",
  "runtime.getSnapshot",
  "runtime.start",
  "runtime.stop",
  "runtime.restart",
  "runtime.validateConfig",
  "runtime.getConfigSummary",
  "runtime.listJobs",
  "runtime.cancelJob",
  "runtime.listArtifacts",
  "runtime.getLogChunk",
  "runtime.subscribeEvents",
  "connection.testLocal",
  "connection.testPublic",
  "setup.getSnapshot",
  "setup.preflight",
  "setup.plan",
  "setup.apply",
  "setup.rollback",
  "setup.reconcile",
  "setup.discardCredential",
]);

const SETUP_V0_5_PROTOCOL_METHODS = new Set([
  "setup.getSnapshot",
  "setup.preflight",
  "setup.plan",
  "setup.apply",
  "setup.rollback",
  "setup.reconcile",
  "setup.discardCredential",
]);

const TEXT_EXTENSIONS = new Set([".js", ".jsx", ".json", ".mjs", ".rs", ".toml", ".ts", ".tsx"]);
const IGNORED_DIRECTORIES = new Set(["dist", "node_modules", "target"]);
const SECRET_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]+=*|\bsk-[A-Za-z0-9_-]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[baprs]-[A-Za-z0-9-]{20,})/iu;
const FORBIDDEN_SHELL = /(?:@tauri-apps\/plugin-shell|tauri-plugin-shell|(?:cmd|powershell|pwsh|bash|zsh)(?:\.exe)?["'`]|["'`]\/bin\/(?:ba)?sh["'`]|(?:ba)?sh\s+-c\b)/iu;
const PUBLIC_ADMIN_ROUTE = /\b(?:app|router)\.(?:all|delete|get|patch|post|put|use)\s*\(\s*["'`](?:\/+(?:admin|control|desktop))(?:\/|["'`])/iu;

function normalized(relativePath) {
  return relativePath.replaceAll("\\", "/");
}

function isProduction(relativePath) {
  const file = normalized(relativePath).toLowerCase();
  return !/(?:^|\/)(?:test|tests|__tests__|fixtures)(?:\/|$)/u.test(file)
    && !/\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(file);
}

function rustFunctionSource(source, name) {
  const signature = source.indexOf(`fn ${name}(`);
  if (signature < 0) return "";
  const opening = source.indexOf("{", signature);
  if (opening < 0) return "";
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(signature, index + 1);
    }
  }
  return source.slice(signature);
}

async function collectFiles(root, base = projectRoot) {
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

function stringsIn(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringsIn(item, output));
  else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((item) => stringsIn(item, output));
  }
  return output;
}

function protocolMethods(schema) {
  const methods = new Set();
  const addMethodValues = (value) => {
    if (typeof value?.const === "string") methods.add(value.const);
    if (Array.isArray(value?.enum)) {
      for (const item of value.enum) if (typeof item === "string") methods.add(item);
    }
  };
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
    } else if (value !== null && typeof value === "object") {
      if (value.properties?.method !== undefined) addMethodValues(value.properties.method);
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(schema);
  return methods;
}

function supportsSetupProtocol(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(String(version ?? ""));
  return match !== null && (Number(match[1]) > 0 || Number(match[2]) >= 5);
}

const SETUP_CREDENTIAL_REQUEST_DEFS = new Set([
  "setupPreflightRequest",
  "setupApplyRequest",
  "setupRollbackRequest",
  "setupReconcileRequest",
]);

const FORBIDDEN_PROTOCOL_SECRET_FIELD = /^(?:password|passwordPlaintext|ownerPassword|ownerHash|oauthToken|accessToken|refreshToken|clientSecret|authorization|secret)$/iu;

function sameStringSet(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && [...actual].sort().every((item, index) => item === [...expected].sort()[index]);
}

function closedCredentialBranch(branch, kind, propertyNames) {
  if (branch?.type !== "object" || branch.additionalProperties !== false) return false;
  if (branch.properties === null || typeof branch.properties !== "object" || Array.isArray(branch.properties)) return false;
  if (!sameStringSet(Object.keys(branch.properties), propertyNames)) return false;
  if (!sameStringSet(branch.required, propertyNames)) return false;
  if (branch.properties.kind?.const !== kind) return false;
  return true;
}

function boundedSecretString(field) {
  return field?.type === "string" && field.minLength === 1
    && Number.isInteger(field.maxLength) && field.maxLength >= 1 && field.maxLength <= 65_536;
}

function boundedEmail(field) {
  return field?.type === "string" && field.format === "email"
    && Number.isInteger(field.minLength) && field.minLength >= 1
    && Number.isInteger(field.maxLength) && field.maxLength >= field.minLength && field.maxLength <= 320;
}

export function analyzeSetupCredentialProtocol(schema) {
  const violations = [];
  const add = (code) => violations.push(code);
  const definition = schema?.$defs?.setupCredential;
  const branches = Array.isArray(definition?.oneOf) ? definition.oneOf : [];
  const apiToken = branches.find((branch) => branch?.properties?.kind?.const === "api_token");
  const globalKey = branches.find((branch) => branch?.properties?.kind?.const === "global_api_key");
  if (branches.length !== 2
    || !closedCredentialBranch(apiToken, "api_token", ["kind", "token"])
    || !boundedSecretString(apiToken?.properties?.token)
    || !closedCredentialBranch(globalKey, "global_api_key", ["kind", "email", "key", "acknowledgement"])
    || !boundedEmail(globalKey?.properties?.email)
    || !boundedSecretString(globalKey?.properties?.key)
    || globalKey?.properties?.acknowledgement?.const !== "I UNDERSTAND GLOBAL API KEY ACCESS") {
    add("SETUP_CREDENTIAL_PROTOCOL_SHAPE_INVALID");
  }

  const allowedCredentialPaths = new Set([...SETUP_CREDENTIAL_REQUEST_DEFS]
    .map((name) => `$defs.${name}.properties.params.properties.credential`));
  const credentialPaths = [];
  const setupCredentialReferencePaths = [];
  const forbiddenSecretPaths = [];
  const visit = (value, pathSegments = []) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...pathSegments, String(index)]));
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (value.$ref === "#/$defs/setupCredential") setupCredentialReferencePaths.push(pathSegments.join("."));
    if (value.properties !== null && typeof value.properties === "object" && !Array.isArray(value.properties)) {
      for (const name of Object.keys(value.properties)) {
        const fieldPath = [...pathSegments, "properties", name].join(".");
        if (name === "credential") credentialPaths.push(fieldPath);
        if (FORBIDDEN_PROTOCOL_SECRET_FIELD.test(name)) forbiddenSecretPaths.push(fieldPath);
        if ((name === "token" || name === "key") && !fieldPath.startsWith("$defs.setupCredential.oneOf.")) {
          forbiddenSecretPaths.push(fieldPath);
        }
      }
    }
    for (const [key, child] of Object.entries(value)) visit(child, [...pathSegments, key]);
  };
  visit(schema);

  if (credentialPaths.length !== allowedCredentialPaths.size
    || credentialPaths.some((value) => !allowedCredentialPaths.has(value))) {
    add("SETUP_CREDENTIAL_FIELD_OUTSIDE_ALLOWED_REQUEST");
  }
  if (setupCredentialReferencePaths.length !== allowedCredentialPaths.size
    || setupCredentialReferencePaths.some((value) => !allowedCredentialPaths.has(value))) {
    add("SETUP_CREDENTIAL_REF_OUTSIDE_ALLOWED_REQUEST");
  }
  for (const name of SETUP_CREDENTIAL_REQUEST_DEFS) {
    const params = schema?.$defs?.[name]?.properties?.params;
    if (params?.properties?.credential?.$ref !== "#/$defs/setupCredential"
      || (params.required ?? []).includes("credential")) {
      add("SETUP_CREDENTIAL_MUST_BE_OPTIONAL");
      break;
    }
  }
  if (forbiddenSecretPaths.length > 0) add("SECRET_FIELD_OUTSIDE_SETUP_CREDENTIAL_IN_NODE_PROTOCOL");
  return [...new Set(violations)].sort();
}

export function analyzeDesktopSecurity(files, documents) {
  const violations = [];
  const add = (code, relativePath) => violations.push({ code, file: normalized(relativePath) });
  const productionDesktop = files.filter((file) => file.relativePath.startsWith("apps/desktop/")
    && isProduction(file.relativePath));
  const productionCore = files.filter((file) => file.relativePath.startsWith("src/")
    && isProduction(file.relativePath));

  if (documents.rootPackage.workspaces !== undefined) add("ROOT_NPM_WORKSPACE_FORBIDDEN", "package.json");
  const rootDependencies = {
    ...documents.rootPackage.dependencies,
    ...documents.rootPackage.devDependencies,
  };
  for (const dependency of ["@tauri-apps/api", "@tauri-apps/cli", "react", "react-dom", "tailwindcss"]) {
    if (rootDependencies[dependency] !== undefined) add("DESKTOP_DEPENDENCY_IN_CORE", "package.json");
  }
  if (documents.rootLock.packages?.["apps/desktop"] !== undefined) {
    add("DESKTOP_PACKAGE_LINKED_IN_CORE_LOCK", "package-lock.json");
  }

  for (const file of productionCore) {
    if (PUBLIC_ADMIN_ROUTE.test(file.text)) add("PUBLIC_ADMIN_ROUTE", file.relativePath);
  }
  for (const file of productionDesktop) {
    if (FORBIDDEN_SHELL.test(file.text)) add("ARBITRARY_SHELL_SURFACE", file.relativePath);
    if (SECRET_VALUE.test(file.text)) add("SECRET_VALUE_IN_DESKTOP_SOURCE", file.relativePath);
    if (/(?:localStorage|sessionStorage)[\s\S]{0,160}\bpassword\b|\bpassword\b[\s\S]{0,160}(?:localStorage|sessionStorage)/iu.test(file.text)) {
      add("PASSWORD_BROWSER_STORAGE", file.relativePath);
    }
    if (/\b(?:CloudFlareAPIKEY|CLOUDFLARE_API_TOKEN|CLOUDFLARE_GLOBAL_API_KEY)\b/u.test(file.text)) {
      add("CLOUDFLARE_CREDENTIAL_IN_V0_4", file.relativePath);
    }
    if (/dangerousRemoteDomainIpcAccess/iu.test(file.text)) add("REMOTE_TAURI_IPC", file.relativePath);
  }

  const nodeSource = productionDesktop.find((file) => file.relativePath.endsWith("/src-tauri/src/node.rs"));
  if (nodeSource !== undefined) {
    const versionProbe = rustFunctionSource(nodeSource.text, "validate_node_executable");
    if (/Command::new\s*\(\s*path\s*\)/u.test(versionProbe)
      && !/\.env_clear\s*\(\s*\)/u.test(versionProbe)) {
      add("NODE_VERSION_PROBE_ENV_INHERITANCE", nodeSource.relativePath);
    }
    const discovery = rustFunctionSource(nodeSource.text, "where_candidates");
    if (/Command::new\s*\(\s*["'`]where\.exe["'`]\s*\)/u.test(discovery)
      && !/\.env_clear\s*\(\s*\)/u.test(discovery)) {
      add("NODE_DISCOVERY_ENV_INHERITANCE", nodeSource.relativePath);
    }
  }

  const capabilityStrings = documents.capabilities.flatMap((item) => stringsIn(item.document));
  for (const permission of capabilityStrings) {
    if (/^(?:fs|process|shell):/iu.test(permission)) add("BROAD_RENDERER_CAPABILITY", "apps/desktop/src-tauri/capabilities");
  }
  if (documents.capabilities.length === 0) add("TAURI_CAPABILITY_MISSING", "apps/desktop/src-tauri/capabilities");

  const tauriApp = documents.tauriConfig.app ?? {};
  if (tauriApp.withGlobalTauri === true) add("GLOBAL_TAURI_API_ENABLED", "apps/desktop/src-tauri/tauri.conf.json");
  if (tauriApp.security?.csp === null || tauriApp.security?.csp === undefined) {
    add("TAURI_CSP_MISSING", "apps/desktop/src-tauri/tauri.conf.json");
  }

  const methods = protocolMethods(documents.protocolSchema);
  const setupProtocolEnabled = supportsSetupProtocol(documents.rootPackage.version);
  for (const method of methods) {
    if (!ALLOWED_PROTOCOL_METHODS.has(method)) add("PROTOCOL_METHOD_OUTSIDE_V0_4", "schemas/desktop-protocol.v1.schema.json");
    if (/^cloudflare\./u.test(method)
      || (/^setup\./u.test(method) && (!setupProtocolEnabled || !SETUP_V0_5_PROTOCOL_METHODS.has(method)))) {
      add("SETUP_METHOD_OUTSIDE_V0_5", "schemas/desktop-protocol.v1.schema.json");
    }
  }
  const protocolText = JSON.stringify(documents.protocolSchema);
  if (/"(?:password|passwordPlaintext|secret|apiToken|globalApiKey)"\s*:/iu.test(protocolText)) {
    add("SECRET_FIELD_IN_NODE_PROTOCOL", "schemas/desktop-protocol.v1.schema.json");
  }
  if (setupProtocolEnabled && [...methods].some((method) => SETUP_V0_5_PROTOCOL_METHODS.has(method))) {
    for (const code of analyzeSetupCredentialProtocol(documents.protocolSchema)) {
      add(code, "schemas/desktop-protocol.v1.schema.json");
    }
  }

  const cargoText = documents.cargoManifest;
  const rustText = productionDesktop.filter((file) => file.relativePath.endsWith(".rs"))
    .map((file) => file.text).join("\n");
  const mainSource = productionDesktop.find((file) => file.relativePath.endsWith("/src-tauri/src/main.rs"));
  if (mainSource !== undefined
    && !/^#!\[cfg_attr\(not\(debug_assertions\), windows_subsystem = "windows"\)\]$/mu.test(mainSource.text)) {
    add("WINDOWS_RELEASE_GUI_SUBSYSTEM_MISSING", mainSource.relativePath);
  }
  const appSource = productionDesktop.find((file) => file.relativePath.endsWith("/src-tauri/src/app.rs"));
  if (appSource !== undefined) {
    const singleInstanceDependency = /^\s*tauri-plugin-single-instance\s*=\s*["']=\d+\.\d+\.\d+["']\s*$/mu.test(cargoText);
    const singleInstancePlugin = appSource.text.search(/\.plugin\s*\(\s*tauri_plugin_single_instance::init\s*\(/u);
    const firstPlugin = appSource.text.search(/\.plugin\s*\(/u);
    const setup = appSource.text.search(/\.setup\s*\(/u);
    const callback = /\.plugin\s*\(\s*tauri_plugin_single_instance::init\s*\(\s*\|[^|]*\|\s*\{(?<body>[\s\S]*?)\}\s*\)\s*\)/u.exec(appSource.text);
    const restoreWindow = rustFunctionSource(appSource.text, "show_main_window");
    const windowEvent = appSource.text.search(/\.on_window_event\s*\(\s*\|window,\s*event\|\s*\{/u);
    const windowEventBody = windowEvent >= 0 && setup > windowEvent
      ? appSource.text.slice(windowEvent, setup)
      : "";
    const mainWindowGuard = windowEventBody.search(/\bwindow\.label\s*\(\s*\)\s*(?:==|!=)\s*["']main["']/u);
    const closeRequested = windowEventBody.search(/\bWindowEvent::CloseRequested\s*\{\s*api\s*,\s*\.\.\s*\}/u);
    const preventClose = windowEventBody.search(/\bapi\.prevent_close\s*\(\s*\)/u);
    const safeQuit = windowEventBody.search(/\brequest_safe_quit\s*\(\s*window\.app_handle\s*\(\s*\)\s*\)/u);
    const destructiveClose = /\b(?:app\.exit|window\.(?:close|destroy))\s*\(/u.test(windowEventBody);
    if (!singleInstanceDependency || singleInstancePlugin < 0) {
      add("SINGLE_INSTANCE_GUARD_MISSING", appSource.relativePath);
    }
    if (singleInstancePlugin < 0 || singleInstancePlugin !== firstPlugin || setup < 0 || singleInstancePlugin > setup) {
      add("SINGLE_INSTANCE_GUARD_NOT_FIRST", appSource.relativePath);
    }
    if (!/\bshow_main_window\s*\(\s*app\s*\)/u.test(callback?.groups?.body ?? "")
      || !/\bwindow\.show\s*\(\s*\)/u.test(restoreWindow)
      || !/\bwindow\.unminimize\s*\(\s*\)/u.test(restoreWindow)
      || !/\bwindow\.set_focus\s*\(\s*\)/u.test(restoreWindow)) {
      add("SINGLE_INSTANCE_WINDOW_RESTORE_MISSING", appSource.relativePath);
    }
    if (windowEvent < 0 || windowEvent > setup || mainWindowGuard < 0 || closeRequested < 0
      || mainWindowGuard > closeRequested || preventClose < closeRequested || safeQuit < preventClose
      || destructiveClose) {
      add("MAIN_WINDOW_CLOSE_GUARD_MISSING", appSource.relativePath);
    }
  }
  for (const [code, expression] of [
    ["RUST_BCRYPT_HASHING_MISSING", /\bbcrypt\b/iu],
    ["RUST_PASSWORD_COMMAND_MISSING", /(?:hash_owner_password|hash_password|password_hash)/iu],
    ["OWNERSHIP_NONCE_MISSING", /nonce/iu],
    ["OWNED_CHILD_HANDLE_MISSING", /(?:std::process::Child|tokio::process::Child|\bChild\b)/u],
    ["ATOMIC_CONFIG_FLOW_MISSING", /(?:atomic|rename)\b/iu],
    ["CONFIG_BACKUP_FLOW_MISSING", /\bbackup\b/iu],
    ["CONFIG_CONFLICT_HASH_MISSING", /(?:content_hash|expected_hash|sha256|\bhash\b)/iu],
  ]) {
    const source = code === "RUST_BCRYPT_HASHING_MISSING" ? `${cargoText}\n${rustText}` : rustText;
    if (!expression.test(source)) add(code, "apps/desktop/src-tauri/src");
  }
  if (setupProtocolEnabled && [...methods].some((method) => SETUP_V0_5_PROTOCOL_METHODS.has(method))
    && (!/renderer_supplied_credential/iu.test(rustText)
      || !/inject_setup_credential/iu.test(rustText)
      || !/contains_key\s*\(\s*"credential"\s*\)/u.test(rustText))) {
    add("RENDERER_CREDENTIAL_REJECTION_MISSING", "apps/desktop/src-tauri/src");
  }

  const unique = new Map(violations.map((item) => [`${item.code}:${item.file}`, item]));
  return [...unique.values()].sort((left, right) => `${left.code}:${left.file}`.localeCompare(`${right.code}:${right.file}`));
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function checkDesktopSecurity() {
  const required = [
    path.join(projectRoot, "package.json"),
    path.join(projectRoot, "package-lock.json"),
    path.join(desktopRoot, "package.json"),
    path.join(desktopRoot, "package-lock.json"),
    path.join(desktopRoot, "src-tauri", "Cargo.toml"),
    path.join(desktopRoot, "src-tauri", "src", "app.rs"),
    path.join(desktopRoot, "src-tauri", "src", "main.rs"),
    path.join(desktopRoot, "src-tauri", "tauri.conf.json"),
    path.join(projectRoot, "schemas", "desktop-protocol.v1.schema.json"),
  ];
  if (!(await Promise.all(required.map(isFile))).every(Boolean)) {
    return { status: "FAIL", reason: "DESKTOP_SECURITY_INPUT_MISSING", violations: [] };
  }

  const capabilityDirectory = path.join(desktopRoot, "src-tauri", "capabilities");
  const capabilityNames = await isDirectory(capabilityDirectory)
    ? (await readdir(capabilityDirectory)).filter((name) => name.endsWith(".json")).sort()
    : [];
  const [desktopFiles, coreFiles, rootPackage, rootLock, tauriConfig, protocolSchema, cargoManifest, ...capabilities] = await Promise.all([
    collectFiles(desktopRoot),
    collectFiles(path.join(projectRoot, "src")),
    readJson(path.join(projectRoot, "package.json")),
    readJson(path.join(projectRoot, "package-lock.json")),
    readJson(path.join(desktopRoot, "src-tauri", "tauri.conf.json")),
    readJson(path.join(projectRoot, "schemas", "desktop-protocol.v1.schema.json")),
    readFile(path.join(desktopRoot, "src-tauri", "Cargo.toml"), "utf8"),
    ...capabilityNames.map((name) => readJson(path.join(capabilityDirectory, name))),
  ]);
  const violations = analyzeDesktopSecurity([...desktopFiles, ...coreFiles], {
    rootPackage,
    rootLock,
    tauriConfig,
    protocolSchema,
    cargoManifest,
    capabilities: capabilities.map((document, index) => ({ name: capabilityNames[index], document })),
  });
  return violations.length === 0
    ? {
        status: "PASS",
        checks: [
          "INDEPENDENT_DESKTOP_PACKAGE",
          "NO_PUBLIC_ADMIN_ROUTE",
          "NO_ARBITRARY_SHELL_OR_PROCESS_CAPABILITY",
          "PASSWORD_HASH_STAYS_IN_RUST",
          "NO_SECRET_VALUE_OR_CLOUDFLARE_CREDENTIAL_SURFACE",
          "ATOMIC_CONFIG_AND_CONFLICT_MARKERS",
          "OWNED_CHILD_AND_NONCE_MARKERS",
          "SINGLE_INSTANCE_GUARD_BEFORE_SETUP",
          "MAIN_WINDOW_CLOSE_GUARD_AND_WINDOWS_GUI_SUBSYSTEM",
          "DESKTOP_VERSIONED_PROTOCOL_BOUNDARY",
          "SETUP_CREDENTIAL_HOST_ONLY_PROTOCOL_BOUNDARY",
        ],
      }
    : { status: "FAIL", reason: "DESKTOP_SECURITY_BOUNDARY_VIOLATION", violations };
}

async function main() {
  try {
    const result = await checkDesktopSecurity();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== "PASS") process.exitCode = 1;
  } catch {
    process.stdout.write(`${JSON.stringify({ status: "FAIL", reason: "DESKTOP_SECURITY_CHECK_FAILED" })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
