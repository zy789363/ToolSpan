import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(ROOT, "examples", "namesilo-assets.input-manifest.json");
const RIGHTS_PATH = path.join(ROOT, "vendor-inputs", "namesilo", "rights-confirmation.json");

function fail(message) {
  throw new Error(`vendor assets check: ${message}`);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function json(filePath, location) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    fail(`cannot parse ${location}: ${error instanceof Error ? error.message : "unknown error"}`);
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

function safeRelative(relativePath, expectedPrefix, location) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || path.isAbsolute(relativePath)) fail(`${location} must be relative`);
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) fail(`${location} must not contain traversal`);
  if (expectedPrefix !== undefined && !normalized.startsWith(expectedPrefix)) fail(`${location} must stay under ${expectedPrefix}`);
  return normalized;
}

export function validateAssetManifest(value) {
  exactKeys(value, ["schemaVersion", "inputArchive", "optional", "fallback", "selectedAssets", "prohibited"], "assetManifest");
  if (value.schemaVersion !== 1 || value.optional !== true || value.fallback !== "text-only-vendor-card") {
    fail("asset manifest must preserve optional text-only fallback semantics");
  }
  safeRelative(value.inputArchive, "vendor-inputs/namesilo/", "assetManifest.inputArchive");
  if (!Array.isArray(value.selectedAssets) || value.selectedAssets.length === 0) fail("assetManifest.selectedAssets must not be empty");
  const targets = new Set();
  for (const [index, asset] of value.selectedAssets.entries()) {
    exactKeys(asset, ["target", "source", "sha256"], `assetManifest.selectedAssets[${index}]`);
    const target = safeRelative(asset.target, "docs/assets/vendors/namesilo/", `assetManifest.selectedAssets[${index}].target`);
    safeRelative(asset.source, undefined, `assetManifest.selectedAssets[${index}].source`);
    if (!/^[a-f0-9]{64}$/u.test(asset.sha256)) fail(`assetManifest.selectedAssets[${index}].sha256 must be lowercase SHA-256`);
    if (targets.has(target)) fail(`assetManifest target is duplicated: ${target}`);
    targets.add(target);
  }
  if (!Array.isArray(value.prohibited) || !value.prohibited.some((item) => /font/iu.test(item)) || !value.prohibited.some((item) => /EPS/iu.test(item))) {
    fail("assetManifest.prohibited must exclude fonts and EPS");
  }
  return value;
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function recursiveFiles(directory) {
  if (!await exists(directory)) return [];
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await recursiveFiles(child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

async function validateFallbackDocument() {
  const content = await readFile(path.join(ROOT, "docs", "setup", "domains-and-namesilo.md"), "utf8");
  if (!content.includes("TEXT_ONLY_FALLBACK") || !content.includes("FALLBACK_PASS")) fail("commercial guide must declare the text-only fallback");
  if (/!\[[^\]]*\]\([^)]*(?:namesilo|vendor)[^)]*\)/iu.test(content) || /<img\b[^>]*(?:namesilo|vendor)/iu.test(content)) {
    fail("text-only fallback document must not embed NameSilo images");
  }
}

async function validateRights(value, targets) {
  exactKeys(value, ["schemaVersion", "provider", "authorizedForDistribution", "confirmedAt", "allowedTargets"], "rightsConfirmation");
  if (value.schemaVersion !== 1 || value.provider !== "namesilo" || value.authorizedForDistribution !== true) {
    fail("rights confirmation must explicitly authorize NameSilo asset distribution");
  }
  if (typeof value.confirmedAt !== "string" || Number.isNaN(Date.parse(value.confirmedAt))) fail("rightsConfirmation.confirmedAt must be a valid date/time");
  if (!Array.isArray(value.allowedTargets) || JSON.stringify([...value.allowedTargets].sort()) !== JSON.stringify([...targets].sort())) {
    fail("rightsConfirmation.allowedTargets must exactly match the selected manifest targets");
  }
}

export async function run() {
  const manifest = validateAssetManifest(await json(MANIFEST_PATH, "NameSilo asset manifest"));
  const targetState = await Promise.all(manifest.selectedAssets.map(async (asset) => ({
    asset,
    absolutePath: path.join(ROOT, ...asset.target.split("/")),
    exists: await exists(path.join(ROOT, ...asset.target.split("/"))),
  })));
  const existing = targetState.filter((entry) => entry.exists);
  const vendorDirectory = path.join(ROOT, "docs", "assets", "vendors", "namesilo");
  const publishedFiles = await recursiveFiles(vendorDirectory);
  const selectedTargets = new Set(manifest.selectedAssets.map((asset) => path.resolve(ROOT, ...asset.target.split("/"))));
  const unselectedFiles = publishedFiles.filter((filePath) => !selectedTargets.has(path.resolve(filePath)));
  if (unselectedFiles.length > 0) fail("published vendor directory contains assets not selected by the input manifest");
  const prohibitedFiles = publishedFiles.filter((filePath) => /\.(?:eps|eot|otf|ttf|woff2?)$/iu.test(filePath));
  if (prohibitedFiles.length > 0) fail("published vendor directory contains prohibited EPS/font files");

  if (existing.length === 0) {
    await validateFallbackDocument();
    const archivePresent = await exists(path.join(ROOT, ...manifest.inputArchive.split("/")));
    const result = {
      status: "FALLBACK_PASS",
      mode: "TEXT_ONLY_FALLBACK",
      vendorAssets: "TEXT_ONLY_FALLBACK",
      selectedAssetsPublished: 0,
      inputArchive: archivePresent ? "PRESENT_NOT_IMPORTED" : "MISSING_OPTIONAL",
      rightsConfirmed: false,
      externalGate: "EXTERNAL_GATE_PENDING",
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }

  if (existing.length !== targetState.length) fail("partial vendor asset set is unsafe; remove it and use text-only fallback");
  const hashMismatches = [];
  for (const entry of targetState) {
    if (await sha256(entry.absolutePath) !== entry.asset.sha256) hashMismatches.push(entry.asset.target);
  }
  if (hashMismatches.length > 0) fail(`vendor asset SHA-256 mismatch: ${hashMismatches.join(", ")}; remove assets and use fallback`);
  if (!await exists(RIGHTS_PATH)) fail("published vendor assets lack local rights confirmation; remove assets and use fallback");
  await validateRights(await json(RIGHTS_PATH, "vendor rights confirmation"), manifest.selectedAssets.map((asset) => asset.target));

  const result = {
    status: "PASS",
    mode: "VERIFIED",
    vendorAssets: "VERIFIED",
    selectedAssetsPublished: targetState.length,
    hashes: "PASS",
    rightsConfirmed: true,
    externalGate: "PASS",
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "vendor assets check failed"}\n`);
    process.exitCode = 1;
  });
}
