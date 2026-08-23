import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKPOINTS, REQUIRED_PROMPTS, validatePrompt } from "./check-setup-prompts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST = path.join(ROOT, "examples", "setup-safe-manifest.example.json");
const SAFE_FIELDS = [
  "schemaVersion", "toolSpanVersion", "instanceName", "localUrl", "desiredHostname", "publicMcpUrl",
  "oauthDiscoveryUrl", "expectedToolCount", "tunnelName", "domainChoice", "officialDocs", "generatedAt",
];
const REQUIRED_PACKAGED_FILES = [
  "docs/setup/index.md",
  "docs/setup/cloudflare-manual.md",
  "docs/setup/cloudflare-zone-onboarding.md",
  "docs/setup/cloudflare-scoped-token.md",
  "docs/setup/cloudflared-runtime-credential.md",
  "docs/setup/chatgpt-custom-mcp.md",
  "docs/setup/domains-and-namesilo.md",
  "docs/setup/agent-assisted.md",
  "docs/setup/troubleshooting-and-rollback.md",
  ...REQUIRED_PROMPTS.map((name) => `docs/prompts/${name}`),
  "config/commercial-links.json",
  "config/commercial-links.schema.json",
  "config/namesilo-offer.snapshot.json",
  "config/namesilo-offer.schema.json",
  "config/chatgpt-mcp-guide.snapshot.json",
  "config/chatgpt-mcp-guide.schema.json",
  "config/cloudflare-api-docs.snapshot.json",
  "config/cloudflare-api-docs.schema.json",
  "schemas/setup-safe-manifest.schema.json",
];

function fail(message) {
  throw new Error(`setup manifest smoke: ${message}`);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function exactKeys(value, expected, location) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${location} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${location} keys must be exactly: ${wanted.join(", ")}`);
  }
}

function safeUrl(value, location, protocol) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${location} must be an absolute URL`);
  }
  if (parsed.protocol !== protocol || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
    fail(`${location} has an unsafe URL form`);
  }
  return parsed;
}

function secretLikeFieldCount(value) {
  let count = 0;
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (/(?:secret|password|passphrase|token|api.?key|private.?key|credential|cookie|owner.?hash|client.?secret|email)/iu.test(key)) count += 1;
      count += secretLikeFieldCount(child);
    }
  }
  return count;
}

function secretLikeValueCount(value) {
  let count = 0;
  if (typeof value === "string") {
    if (/Bearer\s+[A-Za-z0-9._~-]{16,}/u.test(value)
      || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value)
      || /(?:token|secret|password|key)\s*[:=]\s*[A-Za-z0-9+/_=-]{16,}/iu.test(value)
      || /(?:sk|pat|ghp|github_pat|cf)[_-][A-Za-z0-9_-]{20,}/iu.test(value)
      || /^[A-Za-z0-9+/_=-]{32,}$/u.test(value)
      || /^eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}$/u.test(value)) count += 1;
  } else if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) count += secretLikeValueCount(child);
  }
  return count;
}

export function validateSafeManifest(manifest, packageVersion) {
  exactKeys(manifest, SAFE_FIELDS, "safeManifest");
  if (manifest.schemaVersion !== "1.0") fail("safeManifest.schemaVersion must be 1.0");
  if (manifest.toolSpanVersion !== packageVersion) fail("safeManifest.toolSpanVersion must match package.json");
  if (typeof manifest.instanceName !== "string" || manifest.instanceName.length < 1 || manifest.instanceName.length > 80) fail("safeManifest.instanceName is invalid");
  if (/^[A-Za-z]:[\\/]|(?:^|[\\/])Users[\\/]/iu.test(manifest.instanceName)) fail("safeManifest.instanceName must not contain a personal path");
  const local = safeUrl(manifest.localUrl, "safeManifest.localUrl", "http:");
  if (!new Set(["127.0.0.1", "localhost"]).has(local.hostname) || !/^\/$/u.test(local.pathname)) fail("safeManifest.localUrl must be loopback root only");
  if (typeof manifest.desiredHostname !== "string" || !/^[a-z0-9.-]+$/u.test(manifest.desiredHostname) || !manifest.desiredHostname.includes(".")) fail("safeManifest.desiredHostname is invalid");
  const publicMcp = safeUrl(manifest.publicMcpUrl, "safeManifest.publicMcpUrl", "https:");
  const oauth = safeUrl(manifest.oauthDiscoveryUrl, "safeManifest.oauthDiscoveryUrl", "https:");
  if (publicMcp.hostname !== manifest.desiredHostname || publicMcp.port !== "" || publicMcp.pathname !== "/mcp" || publicMcp.search !== "") {
    fail("safeManifest.publicMcpUrl must be the desired hostname's exact HTTPS /mcp URL");
  }
  if (oauth.hostname !== manifest.desiredHostname || oauth.port !== "" || oauth.pathname !== "/.well-known/oauth-authorization-server" || oauth.search !== "") {
    fail("safeManifest.oauthDiscoveryUrl must be the desired hostname's authorization-server discovery URL");
  }
  if (manifest.expectedToolCount !== 27) fail("safeManifest.expectedToolCount must be exactly 27");
  if (typeof manifest.tunnelName !== "string" || manifest.tunnelName.length < 1 || manifest.tunnelName.length > 100) fail("safeManifest.tunnelName is invalid");
  if (/^[A-Za-z]:[\\/]|(?:^|[\\/])Users[\\/]/iu.test(manifest.tunnelName)) fail("safeManifest.tunnelName must not contain a personal path");
  if (!new Set(["existing", "other_registrar", "namesilo_no_referral"]).has(manifest.domainChoice)) {
    fail("safeManifest.domainChoice is invalid");
  }
  if (!Array.isArray(manifest.officialDocs) || manifest.officialDocs.length === 0) fail("safeManifest.officialDocs must not be empty");
  for (const [index, value] of manifest.officialDocs.entries()) {
    const docs = safeUrl(value, `safeManifest.officialDocs[${index}]`, "https:");
    if (!new Set(["developers.cloudflare.com", "developers.openai.com"]).has(docs.hostname)) fail("safeManifest.officialDocs contains an unapproved host");
  }
  if (typeof manifest.generatedAt !== "string" || Number.isNaN(Date.parse(manifest.generatedAt))) fail("safeManifest.generatedAt must be a date-time");
  const secretFields = secretLikeFieldCount(manifest);
  const secretValues = secretLikeValueCount(manifest);
  if (secretFields !== 0 || secretValues !== 0) fail(`safeManifest contains secret-like content (fields=${secretFields}, values=${secretValues})`);
  return { secretFields, secretValues };
}

function validateSchema(schema) {
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema" || schema.type !== "object" || schema.additionalProperties !== false) {
    fail("setup-safe-manifest schema must be a closed JSON Schema 2020-12 object");
  }
  const expected = [...SAFE_FIELDS].sort();
  if (JSON.stringify(Object.keys(schema.properties ?? {}).sort()) !== JSON.stringify(expected)
    || JSON.stringify([...(schema.required ?? [])].sort()) !== JSON.stringify(expected)) {
    fail("setup-safe-manifest schema does not freeze the approved field set");
  }
  if (schema.properties.expectedToolCount?.const !== 27) fail("setup-safe-manifest schema must freeze exact 27 tools");
}

async function npmCli() {
  if (typeof process.env.npm_execpath === "string" && await exists(process.env.npm_execpath)) return process.env.npm_execpath;
  const candidate = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return await exists(candidate) ? candidate : null;
}

async function packageManifest() {
  const cli = await npmCli();
  if (cli === null) fail("cannot locate npm CLI for packaged source smoke");
  const safeEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:secret|password|token|api.?key|private.?key|credential|cloudflare)/iu.test(name)));
  const result = await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, [cli, "pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: ROOT,
      env: safeEnvironment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.on("data", (chunk) => { if (stdout.length < 2_000_000) stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { if (stderr.length < 200_000) stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  if (result.code !== 0) fail(`npm pack --dry-run failed with exit ${String(result.code)}`);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fail("npm pack --dry-run did not return JSON");
  }
  const packageResult = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!packageResult || !Array.isArray(packageResult.files)) fail("npm pack manifest is missing files");
  return packageResult.files.map((file) => String(file.path).replaceAll("\\", "/"));
}

function parseArguments(arguments_) {
  const options = { manifestPath: DEFAULT_MANIFEST, skipPack: false };
  for (const argument of arguments_) {
    if (argument.startsWith("--manifest=")) options.manifestPath = path.resolve(argument.slice(11));
    else if (argument === "--skip-pack") options.skipPack = true;
    else fail(`unknown argument: ${argument}`);
  }
  return options;
}

export async function run(arguments_ = process.argv.slice(2)) {
  const options = parseArguments(arguments_);
  const [packageJson, manifest, schema] = await Promise.all([
    readFile(path.join(ROOT, "package.json"), "utf8").then(JSON.parse),
    readFile(options.manifestPath, "utf8").then(JSON.parse),
    readFile(path.join(ROOT, "schemas", "setup-safe-manifest.schema.json"), "utf8").then(JSON.parse),
  ]);
  validateSchema(schema);
  const safeEvidence = validateSafeManifest(manifest, packageJson.version);
  for (const name of REQUIRED_PROMPTS) {
    const content = await readFile(path.join(ROOT, "docs", "prompts", name), "utf8");
    validatePrompt(content, `docs/prompts/${name}`);
  }

  let packagedFiles = [];
  if (!options.skipPack) {
    packagedFiles = await packageManifest();
    const names = new Set(packagedFiles);
    const missing = REQUIRED_PACKAGED_FILES.filter((name) => !names.has(name));
    if (missing.length > 0) fail(`npm package is missing Setup artifacts: ${missing.join(", ")}`);
    const forbidden = packagedFiles.filter((name) => /^(?:\.toolspan-dev|vendor-inputs|state|secrets)(?:\/|$)/iu.test(name)
      || /(?:^|\/)(?:\.env|rights-confirmation\.json|marketing-assets\.zip)$/iu.test(name));
    if (forbidden.length > 0) fail(`npm package contains local/secret vendor inputs: ${forbidden.join(", ")}`);
  }

  const result = {
    status: "PASS",
    safeManifestSchemaVersion: manifest.schemaVersion,
    expectedToolCount: manifest.expectedToolCount,
    allowedFields: SAFE_FIELDS.length,
    secretLikeFields: safeEvidence.secretFields,
    secretLikeValues: safeEvidence.secretValues,
    checkpoints: CHECKPOINTS.length,
    prompts: REQUIRED_PROMPTS.length,
    packagedSource: options.skipPack ? "SKIPPED" : "PASS",
    requiredPackagedArtifacts: REQUIRED_PACKAGED_FILES.length,
    packagedFileCount: packagedFiles.length,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "setup manifest smoke failed"}\n`);
    process.exitCode = 1;
  });
}
