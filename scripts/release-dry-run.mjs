import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import { gunzipSync } from "node:zlib";

import { resolveNpmCli, verificationEnvironment } from "./desktop-install.mjs";
import { resolveExecutable } from "./desktop-verification-utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(scriptDirectory, "..");
export const releaseEvidenceRoot = path.join(projectRoot, ".toolspan-dev", "evidence", "release");
const desktopRoot = path.join(projectRoot, "apps", "desktop");
const tauriRoot = path.join(desktopRoot, "src-tauri");
export const WINDOWS_X64_RELEASE_TARGET = "x86_64-pc-windows-msvc";
export const SOURCE_PROVENANCE_SCHEMA_VERSION = "1.0";
export const DIST_PROVENANCE_SCHEMA_VERSION = "1.0";
const CARGO_METADATA_ARGUMENTS = Object.freeze([
  "metadata",
  "--locked",
  "--offline",
  "--filter-platform",
  WINDOWS_X64_RELEASE_TARGET,
  "--format-version",
  "1",
  "--manifest-path",
  "Cargo.toml",
]);
const TEXT_FILE = /\.(?:cjs|css|html|js|json|map|md|mjs|toml|ts|tsx|txt|xml|yaml|yml)$/iu;
const NATIVE_BUNDLE = /\.(?:AppImage|deb|dmg|exe|msi|rpm|sig|zip)$/iu;
const SECRET_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\bBasic\s+[A-Za-z0-9+/]{24,}=*|\bsk-[A-Za-z0-9_-]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[baprs]-[A-Za-z0-9-]{20,}|\bAIza[0-9A-Za-z_-]{30,}|[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@)/iu;
const FORBIDDEN_PACKAGE_PATH = /^(?:\.git|\.toolspan-dev|node_modules|src|tests|coverage|state|secrets|vendor-inputs)(?:\/|$)/iu;
const RELEASE_LIFECYCLE_ALLOWLIST = Object.freeze({
  ROOT: Object.freeze({
    prebuild: "node scripts/clean-dist.mjs",
    build: "tsc -p tsconfig.build.json",
    postbuild: "node scripts/bundle-desktop-host.mjs",
  }),
  DESKTOP: Object.freeze({
    prebuild: undefined,
    build: "tsc -p tsconfig.json --noEmit && vite build",
    postbuild: undefined,
  }),
});
const MAX_NPM_TARBALL_BYTES = 128 * 1024 * 1024;
const MAX_NPM_TAR_BYTES = 512 * 1024 * 1024;
const MAX_NPM_PACKAGE_FILE_BYTES = 128 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function releaseError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeRelative(filePath) {
  return filePath.replaceAll("\\", "/");
}

function safeRunName(now = new Date(), suffix = randomBytes(4).toString("hex")) {
  return `run-${now.toISOString().replace(/[-:.]/gu, "").replace("Z", "Z-")}${suffix}`;
}

async function sha256File(filePath) {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function listFiles(root) {
  const result = [];
  const visit = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) result.push(entryPath);
    }
  };
  await visit(root);
  return result.sort((left, right) => left.localeCompare(right));
}

function isWithinRoot(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function hashRecords(records) {
  const hash = createHash("sha256");
  for (const record of records) hash.update(`${JSON.stringify(record)}\n`);
  return hash.digest("hex");
}

async function runCapturedCommand(command, runner, environment, failureCode) {
  let result;
  try {
    result = await runner(command, { environment });
  } catch {
    throw releaseError(failureCode);
  }
  if (!result?.started || result.code !== 0) throw releaseError(failureCode);
  return result.stdout;
}

export function validateSourceProvenance(value) {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "gitHead", "sourceTreeSha256", "sourceFileCount", "dirty",
    "statusSha256", "statusEntryCount",
  ])) return false;
  return value.schemaVersion === SOURCE_PROVENANCE_SCHEMA_VERSION
    && /^[a-f0-9]{40,64}$/iu.test(value.gitHead)
    && /^[a-f0-9]{64}$/iu.test(value.sourceTreeSha256)
    && Number.isInteger(value.sourceFileCount)
    && value.sourceFileCount > 0
    && typeof value.dirty === "boolean"
    && /^[a-f0-9]{64}$/iu.test(value.statusSha256)
    && Number.isInteger(value.statusEntryCount)
    && value.statusEntryCount >= 0;
}

export function compareSourceProvenance(expected, actual) {
  if (!validateSourceProvenance(expected) || !validateSourceProvenance(actual)) {
    return { match: false, mismatches: ["SCHEMA"] };
  }
  const mismatches = [
    "gitHead", "sourceTreeSha256", "sourceFileCount", "dirty", "statusSha256", "statusEntryCount",
  ].filter((key) => expected[key] !== actual[key]);
  return { match: mismatches.length === 0, mismatches };
}

export async function collectSourceProvenance(options = {}) {
  const environment = options.environment ?? process.env;
  const runner = options.runner ?? executeReleaseCommand;
  const git = options.git ?? await resolveExecutable("git", { environment });
  if (git === null) throw releaseError("GIT_NOT_FOUND");
  const gitCommand = (arguments_) => ({
    id: "SOURCE_PROVENANCE_GIT",
    command: git,
    arguments: ["-C", projectRoot, ...arguments_],
    cwd: projectRoot,
    capture: true,
  });
  const [fileList, headOutput, statusOutput] = await Promise.all([
    runCapturedCommand(
      gitCommand(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
      runner,
      environment,
      "RELEASE_SOURCE_PROVENANCE_GIT_FAILED",
    ),
    runCapturedCommand(
      gitCommand(["rev-parse", "HEAD"]),
      runner,
      environment,
      "RELEASE_SOURCE_PROVENANCE_GIT_FAILED",
    ),
    runCapturedCommand(
      gitCommand(["status", "--porcelain=v1", "--untracked-files=all", "-z"]),
      runner,
      environment,
      "RELEASE_SOURCE_PROVENANCE_GIT_FAILED",
    ),
  ]);
  const paths = [...new Set(fileList.split("\0").filter(Boolean).map(normalizeRelative))].sort();
  const records = [];
  for (const relativePath of paths) {
    const filePath = path.resolve(projectRoot, relativePath);
    if (!isWithinRoot(projectRoot, filePath)) throw releaseError("RELEASE_SOURCE_PROVENANCE_PATH_UNSAFE");
    let contentHash = "MISSING";
    try {
      contentHash = await sha256File(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw releaseError("RELEASE_SOURCE_PROVENANCE_READ_FAILED");
    }
    records.push({ path: relativePath, sha256: contentHash });
  }
  const gitHead = headOutput.trim();
  const statusEntries = statusOutput.split("\0").filter(Boolean);
  const provenance = {
    schemaVersion: SOURCE_PROVENANCE_SCHEMA_VERSION,
    gitHead,
    sourceTreeSha256: hashRecords(records),
    sourceFileCount: records.length,
    dirty: statusOutput.length > 0,
    statusSha256: createHash("sha256").update(statusOutput).digest("hex"),
    statusEntryCount: statusEntries.length,
  };
  if (!validateSourceProvenance(provenance)) throw releaseError("RELEASE_SOURCE_PROVENANCE_INVALID");
  return provenance;
}

function tarFieldText(field) {
  const nul = field.indexOf(0);
  const bytes = nul < 0 ? field : field.subarray(0, nul);
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw releaseError("NPM_TARBALL_HEADER_UTF8_INVALID");
  }
}

function tarOctal(field) {
  if ((field[0] & 0x80) !== 0) throw releaseError("NPM_TARBALL_BASE256_UNSUPPORTED");
  const nul = field.indexOf(0);
  const valueBytes = nul < 0 ? field : field.subarray(0, nul);
  const padding = nul < 0 ? Buffer.alloc(0) : field.subarray(nul + 1);
  if (padding.some((byte) => byte !== 0 && byte !== 0x20)) {
    throw releaseError("NPM_TARBALL_OCTAL_INVALID");
  }
  const value = valueBytes.toString("ascii").trim();
  if (value.length === 0) return 0;
  if (!/^[0-7]+$/u.test(value)) throw releaseError("NPM_TARBALL_OCTAL_INVALID");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw releaseError("NPM_TARBALL_OCTAL_INVALID");
  return parsed;
}

function tarHeaderChecksum(header) {
  let checksum = 0;
  for (let index = 0; index < header.length; index += 1) {
    checksum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return checksum;
}

function safePackagedPath(rawPath, extractionRoot, directory) {
  if (rawPath.length === 0 || rawPath.includes("\\") || rawPath.startsWith("/")) {
    throw releaseError("NPM_TARBALL_PATH_UNSAFE");
  }
  const trimmed = directory ? rawPath.replace(/\/+$/u, "") : rawPath;
  const segments = trimmed.split("/");
  if (segments[0] !== "package" || segments.some((segment) => (
    segment.length === 0
      || segment === "."
      || segment === ".."
      || /[\u0000-\u001f<>:"|?*]/u.test(segment)
      || /[. ]$/u.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)
  ))) throw releaseError("NPM_TARBALL_PATH_UNSAFE");
  if (!directory && segments.length < 2) throw releaseError("NPM_TARBALL_PATH_UNSAFE");
  const relativePath = segments.slice(1).join("/");
  const resolvedRoot = path.resolve(extractionRoot);
  const target = path.resolve(resolvedRoot, ...segments.slice(1));
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw releaseError("NPM_TARBALL_PATH_ESCAPE");
  }
  return { relativePath, target };
}

function parseNpmTarball(buffer, extractionRoot) {
  const entries = [];
  const paths = new Set();
  let offset = 0;
  let ended = false;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      ended = true;
      if (buffer.subarray(offset).some((byte) => byte !== 0)) {
        throw releaseError("NPM_TARBALL_TRAILING_DATA");
      }
      break;
    }
    if (tarOctal(header.subarray(148, 156)) !== tarHeaderChecksum(header)) {
      throw releaseError("NPM_TARBALL_CHECKSUM_INVALID");
    }
    const name = tarFieldText(header.subarray(0, 100));
    const prefix = tarFieldText(header.subarray(345, 500));
    const rawPath = prefix.length > 0 ? `${prefix}/${name}` : name;
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const size = tarOctal(header.subarray(124, 136));
    const contentEnd = offset + size;
    const paddedEnd = offset + Math.ceil(size / 512) * 512;
    if (size > MAX_NPM_PACKAGE_FILE_BYTES || contentEnd > buffer.length || paddedEnd > buffer.length) {
      throw releaseError("NPM_TARBALL_ENTRY_SIZE_INVALID");
    }
    if (type !== "0" && type !== "5") throw releaseError("NPM_TARBALL_ENTRY_TYPE_FORBIDDEN");
    if (type === "5" && size !== 0) throw releaseError("NPM_TARBALL_DIRECTORY_HAS_CONTENT");
    if (tarFieldText(header.subarray(157, 257)).length > 0) {
      throw releaseError("NPM_TARBALL_LINK_TARGET_FORBIDDEN");
    }
    const location = safePackagedPath(rawPath, extractionRoot, type === "5");
    if (location.relativePath.length > 0) {
      const key = location.relativePath.toLowerCase();
      if (paths.has(key)) throw releaseError("NPM_TARBALL_DUPLICATE_PATH");
      paths.add(key);
      entries.push({
        path: location.relativePath,
        target: location.target,
        directory: type === "5",
        content: type === "0" ? Buffer.from(buffer.subarray(offset, contentEnd)) : null,
      });
    }
    offset = paddedEnd;
  }
  if (!ended) throw releaseError("NPM_TARBALL_END_MARKER_MISSING");
  return entries;
}

function textControlsAreSafe(text) {
  let unsafe = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code === 0 || code === 0xfffd || (code < 0x20 && ![0x09, 0x0a, 0x0c, 0x0d].includes(code))) unsafe += 1;
  }
  return unsafe === 0;
}

function decodePackagedText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    if ((buffer.length - 2) % 2 !== 0) return null;
    const text = buffer.subarray(2).toString("utf16le");
    return textControlsAreSafe(text) ? { decodings: [{ text, encoding: "UTF-16LE" }] } : null;
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    if ((buffer.length - 2) % 2 !== 0) return null;
    const bytes = Buffer.from(buffer.subarray(2));
    for (let index = 0; index < bytes.length; index += 2) {
      [bytes[index], bytes[index + 1]] = [bytes[index + 1], bytes[index]];
    }
    const text = bytes.toString("utf16le");
    return textControlsAreSafe(text) ? { decodings: [{ text, encoding: "UTF-16BE" }] } : null;
  }
  try {
    const text = UTF8_DECODER.decode(buffer.subarray(
      buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0,
    ));
    if (textControlsAreSafe(text)) return { decodings: [{ text, encoding: "UTF-8" }] };
  } catch {
    // A BOM-less UTF-16LE text file is not valid UTF-8; try it below.
  }
  if (buffer.length >= 4 && buffer.length % 2 === 0) {
    const decodings = [];
    const littleEndian = buffer.toString("utf16le");
    if (textControlsAreSafe(littleEndian)) {
      decodings.push({ text: littleEndian, encoding: "UTF-16LE" });
    }
    const swapped = Buffer.from(buffer);
    for (let index = 0; index < swapped.length; index += 2) {
      [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
    }
    const bigEndian = swapped.toString("utf16le");
    if (textControlsAreSafe(bigEndian) && bigEndian !== littleEndian) {
      decodings.push({ text: bigEndian, encoding: "UTF-16BE" });
    }
    if (decodings.length > 0) return { decodings };
  }
  return null;
}

function textMime(relativePath) {
  if (/\.json$/iu.test(relativePath)) return "application/json";
  if (/\.(?:js|mjs|cjs)$/iu.test(relativePath)) return "text/javascript";
  if (/\.md$/iu.test(relativePath)) return "text/markdown";
  if (/\.xml$/iu.test(relativePath)) return "application/xml";
  if (/\.ya?ml$/iu.test(relativePath)) return "application/yaml";
  return "text/plain";
}

function binaryClassification(buffer) {
  const matches = (bytes) => bytes.every((byte, index) => buffer[index] === byte);
  if (matches([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", reason: "BINARY_MAGIC_PNG", known: true };
  }
  if (matches([0xff, 0xd8, 0xff])) return { mime: "image/jpeg", reason: "BINARY_MAGIC_JPEG", known: true };
  if (matches([0x47, 0x49, 0x46, 0x38])) return { mime: "image/gif", reason: "BINARY_MAGIC_GIF", known: true };
  if (matches([0x50, 0x4b, 0x03, 0x04])) return { mime: "application/zip", reason: "BINARY_MAGIC_ZIP", known: true };
  if (matches([0x1f, 0x8b])) return { mime: "application/gzip", reason: "BINARY_MAGIC_GZIP", known: true };
  if (matches([0x00, 0x61, 0x73, 0x6d])) return { mime: "application/wasm", reason: "BINARY_MAGIC_WASM", known: true };
  if (matches([0x25, 0x50, 0x44, 0x46])) return { mime: "application/pdf", reason: "BINARY_MAGIC_PDF", known: true };
  if (matches([0x4d, 0x5a])) return { mime: "application/vnd.microsoft.portable-executable", reason: "BINARY_MAGIC_PE", known: true };
  if (matches([0x7f, 0x45, 0x4c, 0x46])) return { mime: "application/x-elf", reason: "BINARY_MAGIC_ELF", known: true };
  return { mime: "application/octet-stream", reason: "NO_SUPPORTED_TEXT_ENCODING", known: false };
}

export async function scanNpmTarball({
  tarballPath,
  extractionRoot,
  expectedFiles = null,
  personalPathPrefixes = [],
}) {
  const compressed = await readFile(tarballPath);
  if (compressed.length > MAX_NPM_TARBALL_BYTES) throw releaseError("NPM_TARBALL_TOO_LARGE");
  let archive;
  try {
    archive = gunzipSync(compressed, { maxOutputLength: MAX_NPM_TAR_BYTES });
  } catch {
    throw releaseError("NPM_TARBALL_GZIP_INVALID_OR_TOO_LARGE");
  }
  let extractionOwned = false;
  try {
    await mkdir(extractionRoot);
    extractionOwned = true;
    const entries = parseNpmTarball(archive, extractionRoot);
    const fileEntries = entries.filter((entry) => !entry.directory);
    if (expectedFiles !== null) {
      const actual = fileEntries.map((entry) => entry.path).sort();
      const expected = [...expectedFiles].map((entry) => normalizeRelative(String(entry))).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw releaseError("NPM_TARBALL_MANIFEST_MISMATCH");
      }
    }
    const findings = [];
    const contentScans = [];
    const binarySkips = [];
    for (const entry of entries) {
      if (entry.directory) {
        await mkdir(entry.target, { recursive: true });
        continue;
      }
      await mkdir(path.dirname(entry.target), { recursive: true });
      await writeFile(entry.target, entry.content, { flag: "wx" });
      const binary = binaryClassification(entry.content);
      const decoded = binary.known ? null : decodePackagedText(entry.content);
      if (decoded === null) {
        const { known: _known, ...classification } = binary;
        binarySkips.push({ path: entry.path, ...classification });
        continue;
      }
      contentScans.push({
        path: entry.path,
        bytes: entry.content.length,
        mime: textMime(entry.path),
        encodings: decoded.decodings.map((item) => item.encoding),
      });
      for (const item of decoded.decodings) {
        findings.push(...scanReleaseText(item.text, entry.path, personalPathPrefixes));
      }
    }
    const uniqueFindings = [...new Map(findings.map((finding) => [
      `${finding.path}\u0000${finding.code}`,
      finding,
    ])).values()];
    const unexplained = fileEntries.length - contentScans.length - binarySkips.length;
    if (unexplained !== 0) throw releaseError("NPM_TARBALL_UNEXPLAINED_SCAN_SKIP");
    return {
      status: uniqueFindings.length === 0 ? "PASS" : "FAIL",
      tarballBytes: compressed.length,
      tarballSha256: createHash("sha256").update(compressed).digest("hex"),
      packageFilesEnumerated: fileEntries.length,
      packageFilesContentScanned: contentScans.length,
      packageFilesBinarySkipped: binarySkips.length,
      packageFileContentScans: contentScans,
      packageFileBinarySkipDetails: binarySkips,
      packageFilesUnexplainedSkipped: unexplained,
      findings: uniqueFindings,
    };
  } finally {
    if (extractionOwned) await rm(extractionRoot, { recursive: true, force: true });
  }
}

export function releaseCommandPlan(npmCli, packDirectory) {
  return [
    {
      id: "CORE_BUILD",
      command: process.execPath,
      arguments: [npmCli, "run", "build"],
      cwd: projectRoot,
      capture: false,
    },
    {
      id: "DESKTOP_RENDERER_BUILD",
      command: process.execPath,
      arguments: [npmCli, "--prefix", "apps/desktop", "run", "build"],
      cwd: projectRoot,
      capture: false,
    },
    {
      id: "NPM_PACK",
      command: process.execPath,
      arguments: [npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
      cwd: projectRoot,
      capture: true,
    },
  ];
}

export function cargoMetadataCommandPlan(cargo) {
  return [{
    id: "CARGO_METADATA",
    command: cargo,
    arguments: [...CARGO_METADATA_ARGUMENTS],
    cwd: tauriRoot,
    capture: true,
  }];
}

export function validateCargoMetadataCommandPlan(plan, cargo) {
  const errors = [];
  if (!Array.isArray(plan) || plan.length !== 1) return ["CARGO_METADATA:PLAN_SHAPE_INVALID"];
  const [command] = plan;
  if (command?.id !== "CARGO_METADATA") errors.push("CARGO_METADATA:ID_NOT_ALLOWLISTED");
  if (command?.command !== cargo) errors.push("CARGO_METADATA:UNRESOLVED_EXECUTABLE");
  if (!Array.isArray(command?.arguments) || command.arguments.length === 0) {
    errors.push("CARGO_METADATA:ARGUMENTS_MISSING");
  } else {
    const hasLockedOffline = ["--locked", "--offline"].every((required) => (
      command.arguments.filter((argument) => argument === required).length === 1
    ));
    if (!hasLockedOffline) errors.push("CARGO_METADATA:LOCKED_OFFLINE_REQUIRED");
    const filterIndexes = command.arguments
      .map((argument, index) => argument === "--filter-platform" ? index : -1)
      .filter((index) => index >= 0);
    if (filterIndexes.length !== 1 || command.arguments[filterIndexes[0] + 1] === undefined) {
      errors.push("CARGO_METADATA:FILTER_PLATFORM_REQUIRED");
    } else if (command.arguments[filterIndexes[0] + 1] !== WINDOWS_X64_RELEASE_TARGET) {
      errors.push("CARGO_METADATA:TARGET_NOT_ALLOWLISTED");
    }
    if (command.arguments.length !== CARGO_METADATA_ARGUMENTS.length
      || command.arguments.some((argument, index) => argument !== CARGO_METADATA_ARGUMENTS[index])) {
      errors.push("CARGO_METADATA:ARGUMENTS_NOT_ALLOWLISTED");
    }
  }
  if (command?.cwd !== tauriRoot) errors.push("CARGO_METADATA:WORKING_DIRECTORY_NOT_ALLOWLISTED");
  if (command?.capture !== true) errors.push("CARGO_METADATA:CAPTURE_REQUIRED");
  return errors;
}

export function validateReleaseCommandPlan(plan) {
  const errors = [];
  for (const command of plan) {
    if (command.command !== process.execPath) errors.push(`${command.id}:UNRESOLVED_EXECUTABLE`);
    if (!Array.isArray(command.arguments) || command.arguments.length === 0) errors.push(`${command.id}:ARGUMENTS_MISSING`);
    const actions = Array.isArray(command.arguments) ? command.arguments.map(String) : [];
    if (actions.some((argument) => /^(?:publish|version|tag|release)$/iu.test(argument))) {
      errors.push(`${command.id}:DESTRUCTIVE_RELEASE_ACTION_FORBIDDEN`);
    }
    if (actions.some((argument) => /(?:&&|\|\||[<>]|\$\(|`)/u.test(argument))) {
      errors.push(`${command.id}:SHELL_META_FORBIDDEN`);
    }
  }
  return errors;
}

export function validateReleaseLifecycleScripts(rootPackage, desktopPackage) {
  const errors = [];
  for (const [label, packageDocument] of [["ROOT", rootPackage], ["DESKTOP", desktopPackage]]) {
    const scripts = packageDocument?.scripts;
    for (const [name, expected] of Object.entries(RELEASE_LIFECYCLE_ALLOWLIST[label])) {
      if (scripts?.[name] !== expected) errors.push(`${label}_${name.toUpperCase()}_NOT_ALLOWLISTED`);
    }
  }
  return errors;
}

export function validateReleaseVersions({
  rootPackageVersion,
  desktopPackageVersion,
  tauriVersion,
  cargoVersion,
  distVersion,
}) {
  const errors = [];
  const versions = [
    ["ROOT_PACKAGE", rootPackageVersion],
    ["DESKTOP_PACKAGE", desktopPackageVersion],
    ["TAURI", tauriVersion],
    ["CARGO", cargoVersion],
    ["DIST", distVersion],
  ];
  const rootVersion = rootPackageVersion;
  if (typeof rootVersion !== "string" || rootVersion.trim().length === 0) {
    errors.push("RELEASE_VERSION_MISSING:ROOT_PACKAGE");
    return errors;
  }
  for (const [name, version] of versions.slice(1)) {
    if (typeof version !== "string" || version.trim().length === 0) {
      errors.push(`RELEASE_VERSION_MISSING:${name}`);
    } else if (version !== rootVersion) {
      errors.push(`RELEASE_VERSION_MISMATCH:${name}`);
    }
  }
  return errors;
}

export async function executeReleaseCommand(command, options = {}) {
  const capture = command.capture === true;
  const environment = options.environment ?? process.env;
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(command.command, command.arguments, {
        cwd: command.cwd,
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      });
    } catch (error) {
      resolve({ started: false, code: null, errorCode: error?.code ?? "SPAWN_FAILED", stdout, stderr });
      return;
    }
    if (capture) {
      child.stdout?.on("data", (chunk) => {
        if (stdout.length < 10_000_000) stdout += String(chunk).slice(0, 10_000_000 - stdout.length);
      });
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 1_000_000) stderr += String(chunk).slice(0, 1_000_000 - stderr.length);
      });
    }
    child.once("error", (error) => resolve({
      started: false,
      code: null,
      errorCode: error?.code ?? "SPAWN_FAILED",
      stdout,
      stderr,
    }));
    child.once("close", (code) => resolve({ started: true, code, errorCode: null, stdout, stderr }));
  });
}

function packageNameFromLockPath(lockPath, entry) {
  if (typeof entry.name === "string" && entry.name.length > 0) return entry.name;
  const marker = "node_modules/";
  const index = lockPath.lastIndexOf(marker);
  return index < 0 ? null : lockPath.slice(index + marker.length);
}

export function npmComponentsFromLock(lockDocument, sourceName) {
  const components = [];
  for (const [lockPath, entry] of Object.entries(lockDocument?.packages ?? {})) {
    if (entry === null || typeof entry !== "object" || typeof entry.version !== "string") continue;
    const name = packageNameFromLockPath(lockPath, entry);
    if (name === null) continue;
    components.push({
      ecosystem: "npm",
      name,
      version: entry.version,
      license: typeof entry.license === "string" ? entry.license : "NOASSERTION",
      development: entry.dev === true,
      sourceName,
    });
  }
  return components;
}

export function cargoComponentsFromMetadata(metadata) {
  if (!Array.isArray(metadata?.packages)) throw releaseError("CARGO_METADATA_PACKAGES_MISSING");
  return metadata.packages.map((entry) => ({
    ecosystem: "cargo",
    name: String(entry.name),
    version: String(entry.version),
    license: typeof entry.license === "string" ? entry.license : "NOASSERTION",
    development: false,
    sourceName: "apps/desktop/src-tauri/Cargo.lock",
  }));
}

function encodePurlName(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function componentPurl(component) {
  return `pkg:${component.ecosystem}/${encodePurlName(component.name)}@${encodeURIComponent(component.version)}`;
}

const SPDX_LICENSE_IDS = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "CDLA-Permissive-2.0",
  "ISC",
  "LGPL-2.1-or-later",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "Python-2.0",
  "Unicode-3.0",
  "Unlicense",
  "Zlib",
]);
const SPDX_EXCEPTION_IDS = new Set(["LLVM-exception"]);

function spdxExpressionTokens(value) {
  return value.replaceAll("(", " ( ").replaceAll(")", " ) ").trim().split(/\s+/u).filter(Boolean);
}

function isSpdxLicenseToken(token) {
  return SPDX_LICENSE_IDS.has(token) || /^LicenseRef-[A-Za-z0-9.-]+$/u.test(token);
}

function isValidSpdxExpression(value) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) return false;
  const tokens = spdxExpressionTokens(value);
  let cursor = 0;
  const parsePrimary = () => {
    if (tokens[cursor] === "(") {
      cursor += 1;
      if (!parseOr() || tokens[cursor] !== ")") return false;
      cursor += 1;
      return true;
    }
    if (!isSpdxLicenseToken(tokens[cursor])) return false;
    cursor += 1;
    return true;
  };
  const parseWith = () => {
    const start = cursor;
    if (!parsePrimary()) return false;
    if (tokens[cursor] === "WITH") {
      if (tokens[start] === "(" || !SPDX_EXCEPTION_IDS.has(tokens[cursor + 1])) return false;
      cursor += 2;
    }
    return true;
  };
  const parseAnd = () => {
    if (!parseWith()) return false;
    while (tokens[cursor] === "AND") {
      cursor += 1;
      if (!parseWith()) return false;
    }
    return true;
  };
  const parseOr = () => {
    if (!parseAnd()) return false;
    while (tokens[cursor] === "OR") {
      cursor += 1;
      if (!parseAnd()) return false;
    }
    return true;
  };
  return parseOr() && cursor === tokens.length;
}

function cycloneDxLicenseChoice(value) {
  if (value === "NOASSERTION") return [];
  if (SPDX_LICENSE_IDS.has(value)) return [{ license: { id: value } }];
  if (isValidSpdxExpression(value)) return [{ expression: value }];
  return [{ license: { name: value } }];
}

export function deduplicateComponents(components) {
  const result = new Map();
  for (const component of components) {
    const key = `${component.ecosystem}\u0000${component.name}\u0000${component.version}`;
    const existing = result.get(key);
    if (existing === undefined) {
      result.set(key, { ...component, sourceNames: [component.sourceName] });
    } else if (!existing.sourceNames.includes(component.sourceName)) {
      existing.sourceNames.push(component.sourceName);
      existing.sourceNames.sort();
    }
  }
  return [...result.values()].sort((left, right) => (
    `${left.ecosystem}/${left.name}@${left.version}`.localeCompare(`${right.ecosystem}/${right.name}@${right.version}`)
  ));
}

export function createSpdxSbom({ packageName, packageVersion, components, createdAt, namespace }) {
  const packages = components.map((component, index) => {
    const declaredLicense = component.license === "NOASSERTION" || isValidSpdxExpression(component.license)
      ? component.license : "NOASSERTION";
    return {
      SPDXID: `SPDXRef-Package-${String(index + 1)}`,
      name: component.name,
      versionInfo: component.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: declaredLicense,
      externalRefs: [{
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: componentPurl(component),
      }],
      annotations: [{
        annotationType: "OTHER",
        annotator: "Tool: ToolSpan release-dry-run",
        annotationDate: createdAt,
        comment: declaredLicense === component.license
          ? `Source lockfiles: ${component.sourceNames.join(", ")}`
          : `Source lockfiles: ${component.sourceNames.join(", ")}; non-SPDX freeform license metadata: ${component.license}`,
      }],
    };
  });
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${packageName}-${packageVersion}`,
    documentNamespace: namespace,
    creationInfo: { created: createdAt, creators: ["Tool: ToolSpan release-dry-run"] },
    documentDescribes: packages.map((entry) => entry.SPDXID),
    packages,
  };
}

export function createCycloneDxSbom({ packageName, packageVersion, components, createdAt, serialNumber }) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber,
    version: 1,
    metadata: {
      timestamp: createdAt,
      tools: { components: [{ type: "application", name: "ToolSpan release-dry-run" }] },
      component: { type: "application", name: packageName, version: packageVersion },
    },
    components: components.map((component) => {
      const scoped = component.name.startsWith("@");
      return {
        type: "library",
        "bom-ref": componentPurl(component),
        ...(scoped ? { group: component.name.split("/")[0] } : {}),
        name: scoped ? component.name.split("/").slice(1).join("/") : component.name,
        version: component.version,
        purl: componentPurl(component),
        licenses: cycloneDxLicenseChoice(component.license),
        properties: [
          { name: "toolspan:source-lockfiles", value: component.sourceNames.join(",") },
          { name: "toolspan:development", value: String(component.development) },
        ],
      };
    }),
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function isIsoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isUuidUrn(value) {
  return typeof value === "string"
    && /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function isPurl(value) {
  return typeof value === "string" && /^pkg:(?:npm|cargo)\/[A-Za-z0-9@%._~/-]+@[A-Za-z0-9%._~+-]+$/u.test(value);
}

export function validateSpdx23Sbom(document) {
  const errors = [];
  if (!hasExactKeys(document, [
    "spdxVersion", "dataLicense", "SPDXID", "name", "documentNamespace", "creationInfo",
    "documentDescribes", "packages",
  ])) errors.push("SPDX_SCHEMA_TOP_LEVEL_INVALID");
  if (document?.spdxVersion !== "SPDX-2.3") errors.push("SPDX_VERSION_INVALID");
  if (document?.dataLicense !== "CC0-1.0") errors.push("SPDX_DATA_LICENSE_INVALID");
  if (document?.SPDXID !== "SPDXRef-DOCUMENT") errors.push("SPDX_DOCUMENT_ID_INVALID");
  if (typeof document?.name !== "string" || document.name.length === 0) errors.push("SPDX_NAME_INVALID");
  if (!isUuidUrn(document?.documentNamespace)) errors.push("SPDX_NAMESPACE_INVALID");
  if (!hasExactKeys(document?.creationInfo, ["created", "creators"])
    || !isIsoTimestamp(document?.creationInfo?.created)
    || !Array.isArray(document?.creationInfo?.creators)
    || document.creationInfo.creators.length === 0
    || !document.creationInfo.creators.every((entry) => typeof entry === "string" && /^Tool: /u.test(entry))) {
    errors.push("SPDX_CREATION_INFO_INVALID");
  }
  if (!Array.isArray(document?.packages)) {
    errors.push("SPDX_PACKAGES_INVALID");
    return [...new Set(errors)];
  }
  const ids = new Set();
  const purls = new Set();
  for (const component of document.packages) {
    if (!hasExactKeys(component, [
      "SPDXID", "name", "versionInfo", "downloadLocation", "filesAnalyzed", "licenseConcluded",
      "licenseDeclared", "externalRefs", "annotations",
    ])) errors.push("SPDX_PACKAGE_SCHEMA_INVALID");
    if (typeof component?.SPDXID !== "string" || !/^SPDXRef-[A-Za-z0-9.-]+$/u.test(component.SPDXID)
      || ids.has(component.SPDXID)) errors.push("SPDX_PACKAGE_ID_INVALID");
    else ids.add(component.SPDXID);
    if (typeof component?.name !== "string" || component.name.length === 0
      || typeof component?.versionInfo !== "string" || component.versionInfo.length === 0
      || component?.downloadLocation !== "NOASSERTION"
      || component?.filesAnalyzed !== false
      || component?.licenseConcluded !== "NOASSERTION"
      || !(component?.licenseDeclared === "NOASSERTION"
        || component?.licenseDeclared === "NONE"
        || isValidSpdxExpression(component?.licenseDeclared))) {
      errors.push("SPDX_PACKAGE_SEMANTICS_INVALID");
    }
    if (!Array.isArray(component?.externalRefs) || component.externalRefs.length !== 1
      || !hasExactKeys(component.externalRefs[0], ["referenceCategory", "referenceType", "referenceLocator"])
      || component.externalRefs[0].referenceCategory !== "PACKAGE-MANAGER"
      || component.externalRefs[0].referenceType !== "purl"
      || !isPurl(component.externalRefs[0].referenceLocator)
      || purls.has(component.externalRefs[0].referenceLocator)) errors.push("SPDX_PURL_INVALID");
    else purls.add(component.externalRefs[0].referenceLocator);
    if (!Array.isArray(component?.annotations) || component.annotations.length !== 1
      || !hasExactKeys(component.annotations[0], [
        "annotationType", "annotator", "annotationDate", "comment",
      ])
      || component.annotations[0].annotationType !== "OTHER"
      || typeof component.annotations[0].annotator !== "string"
      || !isIsoTimestamp(component.annotations[0].annotationDate)
      || typeof component.annotations[0].comment !== "string") errors.push("SPDX_ANNOTATION_INVALID");
  }
  if (!Array.isArray(document.documentDescribes)
    || document.documentDescribes.length !== ids.size
    || new Set(document.documentDescribes).size !== document.documentDescribes.length
    || document.documentDescribes.some((identifier) => !ids.has(identifier))) {
    errors.push("SPDX_DOCUMENT_DESCRIBES_INVALID");
  }
  return [...new Set(errors)];
}

export function validateCycloneDx16Sbom(document) {
  const errors = [];
  if (!hasExactKeys(document, ["bomFormat", "specVersion", "serialNumber", "version", "metadata", "components"])) {
    errors.push("CYCLONEDX_SCHEMA_TOP_LEVEL_INVALID");
  }
  if (document?.bomFormat !== "CycloneDX" || document?.specVersion !== "1.6") {
    errors.push("CYCLONEDX_VERSION_INVALID");
  }
  if (!isUuidUrn(document?.serialNumber) || document?.version !== 1) errors.push("CYCLONEDX_SERIAL_INVALID");
  if (!hasExactKeys(document?.metadata, ["timestamp", "tools", "component"])
    || !isIsoTimestamp(document?.metadata?.timestamp)
    || !hasExactKeys(document?.metadata?.tools, ["components"])
    || !Array.isArray(document?.metadata?.tools?.components)
    || document.metadata.tools.components.length !== 1
    || !hasExactKeys(document.metadata.tools.components[0], ["type", "name"])
    || document.metadata.tools.components[0].type !== "application"
    || typeof document.metadata.tools.components[0].name !== "string"
    || !hasExactKeys(document?.metadata?.component, ["type", "name", "version"])
    || document.metadata.component.type !== "application"
    || typeof document.metadata.component.name !== "string"
    || typeof document.metadata.component.version !== "string") errors.push("CYCLONEDX_METADATA_INVALID");
  if (!Array.isArray(document?.components)) {
    errors.push("CYCLONEDX_COMPONENTS_INVALID");
    return [...new Set(errors)];
  }
  const references = new Set();
  for (const component of document.components) {
    const expectedKeys = ["type", "bom-ref", "name", "version", "purl", "licenses", "properties"];
    if (Object.hasOwn(component ?? {}, "group")) expectedKeys.push("group");
    if (!hasExactKeys(component, expectedKeys)) errors.push("CYCLONEDX_COMPONENT_SCHEMA_INVALID");
    if (component?.type !== "library"
      || typeof component?.name !== "string" || component.name.length === 0
      || typeof component?.version !== "string" || component.version.length === 0
      || (Object.hasOwn(component ?? {}, "group") && (typeof component.group !== "string" || !component.group.startsWith("@")))
      || !isPurl(component?.purl)
      || component?.["bom-ref"] !== component?.purl
      || references.has(component?.["bom-ref"])) errors.push("CYCLONEDX_COMPONENT_SEMANTICS_INVALID");
    else references.add(component["bom-ref"]);
    if (!Array.isArray(component?.licenses) || component.licenses.length > 1) {
      errors.push("CYCLONEDX_LICENSE_SCHEMA_INVALID");
    } else if (component.licenses.length === 1) {
      const choice = component.licenses[0];
      if (hasExactKeys(choice, ["expression"])) {
        if (!isValidSpdxExpression(choice.expression)
          || !/\b(?:AND|OR|WITH)\b|[()]/u.test(choice.expression)) errors.push("CYCLONEDX_LICENSE_EXPRESSION_INVALID");
      } else if (hasExactKeys(choice, ["license"]) && isRecord(choice.license)) {
        if (hasExactKeys(choice.license, ["id"])) {
          if (!SPDX_LICENSE_IDS.has(choice.license.id)) errors.push("CYCLONEDX_LICENSE_ID_INVALID");
        } else if (hasExactKeys(choice.license, ["name"])) {
          if (typeof choice.license.name !== "string" || choice.license.name.trim().length === 0) {
            errors.push("CYCLONEDX_LICENSE_NAME_INVALID");
          }
        } else errors.push("CYCLONEDX_LICENSE_SCHEMA_INVALID");
      } else errors.push("CYCLONEDX_LICENSE_SCHEMA_INVALID");
    }
    if (!Array.isArray(component?.properties) || component.properties.length !== 2
      || !component.properties.every((property) => (
        hasExactKeys(property, ["name", "value"])
          && typeof property.name === "string"
          && typeof property.value === "string"
      ))) errors.push("CYCLONEDX_PROPERTIES_INVALID");
  }
  return [...new Set(errors)];
}

export function validatePackedFiles(files, allowlist) {
  const errors = [];
  const names = files.map((entry) => normalizeRelative(String(entry.path)));
  for (const required of allowlist.required ?? []) {
    if (!names.includes(required)) errors.push(`PACKAGE_REQUIRED_FILE_MISSING:${required}`);
  }
  for (const name of names) {
    const allowed = (allowlist.allowedExact ?? []).includes(name)
      || (allowlist.allowedPrefixes ?? []).some((prefix) => name.startsWith(prefix));
    if (!allowed) errors.push(`PACKAGE_FILE_OUTSIDE_ALLOWLIST:${name}`);
    if (FORBIDDEN_PACKAGE_PATH.test(name)
      || /(?:^|\/)\.env(?:\.[^/]+)?(?:\/|$)/iu.test(name)
      || /(?:^|\/)(?:\.npmrc|owner\.bcrypt|preview-secret\.bin)$/iu.test(name)
      || /\.(?:key|log|pem|pfx)$/iu.test(name)) {
      errors.push(`PACKAGE_FORBIDDEN_FILE:${name}`);
    }
  }
  return errors;
}

export function scanReleaseText(text, relativePath, personalPathPrefixes = []) {
  const findings = [];
  if (SECRET_VALUE.test(text)) findings.push({ path: relativePath, code: "SECRET_LIKE_VALUE" });
  for (const prefix of personalPathPrefixes) {
    if (typeof prefix === "string" && prefix.length >= 4 && text.toLowerCase().includes(prefix.toLowerCase())) {
      findings.push({ path: relativePath, code: "PERSONAL_ABSOLUTE_PATH" });
      break;
    }
  }
  return findings;
}

export function scanNativeInstallerRawAsciiUtf16Patterns(
  bytes,
  relativePath,
  personalPathPrefixes = [],
) {
  const findingsByKey = new Map();
  for (const text of [
    bytes.toString("latin1"),
    bytes.toString("utf16le"),
    bytes.subarray(1).toString("utf16le"),
  ]) {
    for (const finding of scanReleaseText(text, relativePath, personalPathPrefixes)) {
      findingsByKey.set(`${finding.path}\u0000${finding.code}`, finding);
    }
  }
  const findings = [...findingsByKey.values()];
  return {
    status: findings.length === 0 ? "PASS" : "FAIL",
    scope: "RAW_INSTALLER_FILE_BYTES_ONLY",
    encodings: ["ASCII", "UTF-16LE"],
    utf16LeByteAlignments: [0, 1],
    compressedPayloadCoverage: false,
    limitation: "COMPRESSED_OR_ENCRYPTED_PAYLOADS_NOT_INSPECTED",
    findings,
  };
}

async function cargoMetadata(cargo, environment, runner) {
  const plan = cargoMetadataCommandPlan(cargo);
  const planErrors = validateCargoMetadataCommandPlan(plan, cargo);
  if (planErrors.length > 0) throw releaseError("CARGO_METADATA_COMMAND_PLAN_UNSAFE");
  const [command] = plan;
  const result = await runner(command, { environment });
  if (!result.started || result.code !== 0) throw releaseError("CARGO_METADATA_FAILED");
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw releaseError("CARGO_METADATA_JSON_INVALID");
  }
}

async function collectRendererManifest() {
  const root = path.join(desktopRoot, "dist");
  const files = await listFiles(root);
  if (files.length === 0) throw releaseError("DESKTOP_RENDERER_BUILD_EMPTY");
  return await Promise.all(files.map(async (filePath) => ({
    path: normalizeRelative(path.relative(root, filePath)),
    bytes: (await stat(filePath)).size,
    sha256: await sha256File(filePath),
  })));
}

async function collectDirectoryProvenance(root, requiredFile) {
  const files = await listFiles(root);
  if (files.length === 0 || !files.some((filePath) => path.basename(filePath) === requiredFile)) {
    throw releaseError("RELEASE_DIST_OUTPUT_MISSING");
  }
  const records = await Promise.all(files.map(async (filePath) => ({
    path: normalizeRelative(path.relative(projectRoot, filePath)),
    bytes: (await stat(filePath)).size,
    sha256: await sha256File(filePath),
  })));
  return {
    directory: normalizeRelative(path.relative(projectRoot, root)),
    fileCount: records.length,
    sha256: hashRecords(records),
  };
}

async function collectRendererSourceMapProvenance(rendererRoot) {
  const mapFiles = (await listFiles(rendererRoot)).filter((filePath) => filePath.endsWith(".map"));
  if (mapFiles.length === 0) throw releaseError("RELEASE_RENDERER_SOURCEMAP_MISSING");
  const sourceRoot = path.join(desktopRoot, "src");
  let mappedSourceFiles = 0;
  for (const mapFile of mapFiles) {
    let sourceMap;
    try {
      sourceMap = JSON.parse(await readFile(mapFile, "utf8"));
    } catch {
      throw releaseError("RELEASE_RENDERER_SOURCEMAP_INVALID");
    }
    if (!Array.isArray(sourceMap.sources) || !Array.isArray(sourceMap.sourcesContent)
      || sourceMap.sources.length !== sourceMap.sourcesContent.length) {
      throw releaseError("RELEASE_RENDERER_SOURCEMAP_INVALID");
    }
    for (let index = 0; index < sourceMap.sources.length; index += 1) {
      const source = sourceMap.sources[index];
      const content = sourceMap.sourcesContent[index];
      if (typeof source !== "string" || typeof content !== "string") continue;
      const sourcePath = path.resolve(path.dirname(mapFile), source);
      if (!isWithinRoot(sourceRoot, sourcePath)) continue;
      try {
        if (content !== await readFile(sourcePath, "utf8")) {
          throw releaseError("RELEASE_RENDERER_SOURCEMAP_STALE");
        }
      } catch (error) {
        if (error?.code === "ENOENT") throw releaseError("RELEASE_RENDERER_SOURCE_MISSING");
        throw error;
      }
      mappedSourceFiles += 1;
    }
  }
  if (mappedSourceFiles === 0) throw releaseError("RELEASE_RENDERER_SOURCEMAP_HAS_NO_SOURCE");
  return { sourceMapFiles: mapFiles.length, mappedSourceFiles };
}

async function builtServiceVersion() {
  const serviceInfoPath = path.join(projectRoot, "dist", "service-info.js");
  try {
    const module = await import(`${pathToFileURL(serviceInfoPath).href}?release=${randomUUID()}`);
    return module.SERVICE_INFO?.version;
  } catch {
    throw releaseError("RELEASE_DIST_SERVICE_INFO_INVALID");
  }
}

export async function collectDistProvenance(options = {}) {
  const rootDist = path.join(projectRoot, "dist");
  const rendererDist = path.join(desktopRoot, "dist");
  const [root, renderer, serviceInfoVersion, rendererSourceMap] = await Promise.all([
    collectDirectoryProvenance(rootDist, "service-info.js"),
    collectDirectoryProvenance(rendererDist, "index.html"),
    options.serviceInfoVersion ?? builtServiceVersion(),
    collectRendererSourceMapProvenance(rendererDist),
  ]);
  return {
    schemaVersion: DIST_PROVENANCE_SCHEMA_VERSION,
    toolSpanVersion: options.toolSpanVersion ?? serviceInfoVersion,
    root: { ...root, serviceInfoVersion },
    renderer: { ...renderer, ...rendererSourceMap },
  };
}

export function validateDistProvenance(value, expectedVersion = undefined) {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "toolSpanVersion", "root", "renderer"])
    || !isRecord(value.root) || !isRecord(value.renderer)
    || !hasExactKeys(value.root, ["directory", "fileCount", "sha256", "serviceInfoVersion"])
    || !hasExactKeys(value.renderer, ["directory", "fileCount", "sha256", "sourceMapFiles", "mappedSourceFiles"])) {
    return false;
  }
  const hash = (candidate) => typeof candidate === "string" && /^[a-f0-9]{64}$/iu.test(candidate);
  return value.schemaVersion === DIST_PROVENANCE_SCHEMA_VERSION
    && typeof value.toolSpanVersion === "string"
    && (expectedVersion === undefined || value.toolSpanVersion === expectedVersion)
    && value.root.directory === "dist"
    && Number.isInteger(value.root.fileCount) && value.root.fileCount > 0
    && hash(value.root.sha256)
    && value.root.serviceInfoVersion === value.toolSpanVersion
    && value.renderer.directory === "apps/desktop/dist"
    && Number.isInteger(value.renderer.fileCount) && value.renderer.fileCount > 0
    && hash(value.renderer.sha256)
    && Number.isInteger(value.renderer.sourceMapFiles) && value.renderer.sourceMapFiles > 0
    && Number.isInteger(value.renderer.mappedSourceFiles) && value.renderer.mappedSourceFiles > 0;
}

export function compareDistProvenance(expected, actual) {
  if (!validateDistProvenance(expected) || !validateDistProvenance(actual)) {
    return { match: false, mismatches: ["SCHEMA"] };
  }
  const mismatches = [
    "schemaVersion", "toolSpanVersion", "root", "renderer",
  ].filter((key) => JSON.stringify(expected[key]) !== JSON.stringify(actual[key]));
  return { match: mismatches.length === 0, mismatches };
}

export function selectNativeBundleCandidates(candidates, packageVersion) {
  const stale = [];
  const rejected = [];
  const current = [];
  const expected = new Map([
    [`ToolSpan_${packageVersion}_x64-setup.exe`, "nsis"],
    [`ToolSpan_${packageVersion}_x64_en-US.msi`, "msi"],
  ]);
  const toolSpanArtifact = /^ToolSpan_(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)_x64(?:-setup\.exe|_en-US\.msi)$/u;
  for (const candidate of candidates) {
    const targetName = String(candidate.targetName);
    const knownArtifact = toolSpanArtifact.exec(targetName);
    if (knownArtifact !== null && knownArtifact.groups?.version !== packageVersion) {
      stale.push(candidate);
      continue;
    }
    const bundleType = expected.get(targetName);
    if (bundleType === undefined) {
      rejected.push({ ...candidate, rejection: "TARGET_NOT_ALLOWLISTED" });
      continue;
    }
    if (candidate.sourceProfile !== "release") {
      rejected.push({ ...candidate, rejection: "PROFILE_NOT_RELEASE" });
      continue;
    }
    const expectedSource = `apps/desktop/src-tauri/target/release/bundle/${bundleType}/${targetName}`;
    if (normalizeRelative(String(candidate.source)) !== expectedSource) {
      rejected.push({ ...candidate, rejection: "SOURCE_PATH_MISMATCH" });
      continue;
    }
    current.push({ ...candidate, selection: "RELEASE_SHIPPING_ARTIFACT" });
  }
  current.sort((left, right) => (
    left.targetName.localeCompare(right.targetName)
      || left.source.localeCompare(right.source)
  ));
  const selectedByTargetName = new Map();
  for (const candidate of current) {
    const key = candidate.targetName.toLowerCase();
    if (selectedByTargetName.has(key)) {
      rejected.push({ ...candidate, rejection: "DUPLICATE_SHIPPING_TARGET" });
      continue;
    }
    selectedByTargetName.set(key, candidate);
  }
  stale.sort((left, right) => left.source.localeCompare(right.source));
  rejected.sort((left, right) => left.source.localeCompare(right.source));
  return { current: [...selectedByTargetName.values()], stale, rejected };
}

async function collectNativeBundles(packageVersion, runDirectory) {
  const bundleRoots = [
    { sourceProfile: "debug", root: path.join(tauriRoot, "target", "debug", "bundle") },
    { sourceProfile: "release", root: path.join(tauriRoot, "target", "release", "bundle") },
  ];
  const candidates = [];
  for (const bundleRoot of bundleRoots) {
    for (const filePath of await listFiles(bundleRoot.root)) {
      if (!NATIVE_BUNDLE.test(filePath)) continue;
      candidates.push({
        filePath,
        targetName: path.basename(filePath),
        source: normalizeRelative(path.relative(projectRoot, filePath)),
        sourceProfile: bundleRoot.sourceProfile,
        bytes: (await stat(filePath)).size,
      });
    }
  }
  const selection = selectNativeBundleCandidates(candidates, packageVersion);
  const current = [];
  const destination = path.join(runDirectory, "desktop-native");
  for (const selected of selection.current) {
    await mkdir(destination, { recursive: true });
    const target = path.join(destination, selected.targetName);
    await copyFile(selected.filePath, target);
    const { filePath: _filePath, ...record } = selected;
    current.push({
      ...record,
      artifact: `desktop-native/${selected.targetName}`,
      sha256: await sha256File(target),
    });
  }
  return {
    status: current.length > 0 ? "ASSEMBLED_NOT_NATIVE_VALIDATED" : "EXTERNAL_GATE_PENDING",
    current,
    stale: selection.stale.map(({ filePath: _filePath, ...record }) => record),
    rejected: selection.rejected.map(({ filePath: _filePath, ...record }) => record),
  };
}

function parsePackJson(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw releaseError("NPM_PACK_JSON_INVALID");
  }
  const result = Array.isArray(value) ? value[0] : value;
  if (result === null || typeof result !== "object" || typeof result.filename !== "string"
    || !Array.isArray(result.files)) throw releaseError("NPM_PACK_MANIFEST_MISSING");
  return result;
}

export async function runReleaseDryRun(options = {}) {
  const now = options.now ?? new Date();
  const createdAt = now.toISOString();
  const runName = options.runName ?? safeRunName(now);
  const runDirectory = path.join(releaseEvidenceRoot, runName);
  const packDirectory = path.join(runDirectory, "package");
  await mkdir(packDirectory, { recursive: true });

  const environment = verificationEnvironment(options.environment ?? process.env);
  const sourceBefore = options.sourceProvenance
    ?? await collectSourceProvenance({ environment, runner: options.provenanceRunner });
  const npmCli = options.npmCli ?? await resolveNpmCli(environment);
  if (npmCli === null) throw releaseError("NPM_CLI_NOT_FOUND");
  const cargo = options.cargo ?? await resolveExecutable("cargo", { environment });
  if (cargo === null) throw releaseError("CARGO_NOT_FOUND");
  const runner = options.runner ?? executeReleaseCommand;

  const [packageDocument, desktopPackage, tauriConfig, cargoManifestText, rootLock, desktopLock, allowlist] = await Promise.all([
    readFile(path.join(projectRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(desktopRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(tauriRoot, "tauri.conf.json"), "utf8").then(JSON.parse),
    readFile(path.join(tauriRoot, "Cargo.toml"), "utf8"),
    readFile(path.join(projectRoot, "package-lock.json"), "utf8").then(JSON.parse),
    readFile(path.join(desktopRoot, "package-lock.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "scripts", "release-package-allowlist.json"), "utf8").then(JSON.parse),
  ]);
  const cargoVersion = /^version\s*=\s*"([^"]+)"\s*$/mu.exec(cargoManifestText)?.[1];
  if (validateReleaseVersions({
    rootPackageVersion: packageDocument.version,
    desktopPackageVersion: desktopPackage.version,
    tauriVersion: tauriConfig.version,
    cargoVersion,
  }).length > 0) throw releaseError("RELEASE_VERSION_MISMATCH");

  const lifecycleErrors = validateReleaseLifecycleScripts(packageDocument, desktopPackage);
  if (lifecycleErrors.length > 0) throw releaseError("RELEASE_LIFECYCLE_NOT_ALLOWLISTED");

  const plan = releaseCommandPlan(npmCli, packDirectory);
  const planErrors = validateReleaseCommandPlan(plan);
  if (planErrors.length > 0) throw releaseError("RELEASE_COMMAND_PLAN_UNSAFE");
  let packResult;
  for (const command of plan) {
    const result = await runner(command, { environment });
    if (!result.started || result.code !== 0) throw releaseError(`${command.id}_FAILED`);
    if (command.id === "NPM_PACK") packResult = parsePackJson(result.stdout);
  }
  if (packResult === undefined) throw releaseError("NPM_PACK_NOT_EXECUTED");
  const sourceAfter = options.sourceProvenanceAfter
    ?? (options.sourceProvenance
      ?? await collectSourceProvenance({ environment, runner: options.provenanceRunner }));
  if (!compareSourceProvenance(sourceBefore, sourceAfter).match) {
    throw releaseError("RELEASE_SOURCE_CHANGED_DURING_BUILD");
  }
  const packageErrors = validatePackedFiles(packResult.files, allowlist);
  if (packageErrors.length > 0) {
    await writeJson(path.join(runDirectory, "package-findings.json"), {
      status: "FAIL",
      findings: packageErrors,
    });
    throw releaseError("NPM_PACKAGE_POLICY_FAILED");
  }

  if (packResult.filename !== path.basename(packResult.filename) || !/^[A-Za-z0-9._-]+\.tgz$/u.test(packResult.filename)) {
    throw releaseError("NPM_PACK_FILENAME_UNSAFE");
  }
  const tarballPath = path.join(packDirectory, packResult.filename);
  const personalPrefixes = [
    options.environment?.USERPROFILE ?? process.env.USERPROFILE,
    options.environment?.HOME ?? process.env.HOME,
  ].filter((value) => typeof value === "string" && value.length >= 4);
  const packageScan = await scanNpmTarball({
    tarballPath,
    extractionRoot: path.join(runDirectory, "package-extracted"),
    expectedFiles: packResult.files.map((entry) => entry.path),
    personalPathPrefixes: personalPrefixes,
  });
  const tarball = {
    path: `package/${packResult.filename}`,
    bytes: packageScan.tarballBytes,
    sha256: packageScan.tarballSha256,
    packagedFiles: packResult.files.length,
  };
  const rendererFiles = await collectRendererManifest();
  const distProvenance = options.distProvenance ?? await collectDistProvenance({
    toolSpanVersion: packageDocument.version,
  });
  if (!validateDistProvenance(distProvenance, packageDocument.version)
    || validateReleaseVersions({
      rootPackageVersion: packageDocument.version,
      desktopPackageVersion: desktopPackage.version,
      tauriVersion: tauriConfig.version,
      cargoVersion,
      distVersion: distProvenance.root.serviceInfoVersion,
    }).length > 0) {
    throw releaseError("RELEASE_VERSION_MISMATCH");
  }
  const nativeBundles = await collectNativeBundles(packageDocument.version, runDirectory);
  const metadata = await cargoMetadata(cargo, environment, runner);
  const components = deduplicateComponents([
    ...npmComponentsFromLock(rootLock, "package-lock.json"),
    ...npmComponentsFromLock(desktopLock, "apps/desktop/package-lock.json"),
    ...cargoComponentsFromMetadata(metadata),
  ]);

  const spdx = createSpdxSbom({
    packageName: packageDocument.name,
    packageVersion: packageDocument.version,
    components,
    createdAt,
    namespace: `urn:uuid:${randomUUID()}`,
  });
  const cycloneDx = createCycloneDxSbom({
    packageName: packageDocument.name,
    packageVersion: packageDocument.version,
    components,
    createdAt,
    serialNumber: `urn:uuid:${randomUUID()}`,
  });
  const emittedSpdx = JSON.parse(JSON.stringify(spdx));
  const emittedCycloneDx = JSON.parse(JSON.stringify(cycloneDx));
  const spdxValidationErrors = validateSpdx23Sbom(emittedSpdx);
  const cycloneDxValidationErrors = validateCycloneDx16Sbom(emittedCycloneDx);
  const sbomValidation = {
    schemaVersion: "1.0",
    status: spdxValidationErrors.length === 0 && cycloneDxValidationErrors.length === 0 ? "PASS" : "FAIL",
    mode: "OFFLINE_CLOSED_SCHEMA_AND_SEMANTIC_VALIDATION",
    spdx23: { status: spdxValidationErrors.length === 0 ? "PASS" : "FAIL", errors: spdxValidationErrors },
    cycloneDx16: {
      status: cycloneDxValidationErrors.length === 0 ? "PASS" : "FAIL",
      errors: cycloneDxValidationErrors,
    },
  };
  if (sbomValidation.status !== "PASS") {
    await writeJson(path.join(runDirectory, "sbom-validation.json"), sbomValidation);
    throw releaseError("SBOM_OFFLINE_VALIDATION_FAILED");
  }
  const inputHashes = await Promise.all([
    "package-lock.json",
    "apps/desktop/package-lock.json",
    "apps/desktop/src-tauri/Cargo.lock",
    "apps/desktop/src-tauri/Cargo.toml",
  ].map(async (relativePath) => ({ path: relativePath, sha256: await sha256File(path.join(projectRoot, relativePath)) })));

  const scanFindings = [...packageScan.findings];
  const rendererRoot = path.join(desktopRoot, "dist");
  for (const filePath of await listFiles(rendererRoot)) {
    if (!TEXT_FILE.test(filePath)) continue;
    scanFindings.push(...scanReleaseText(
      await readFile(filePath, "utf8"),
      `desktop-renderer/${normalizeRelative(path.relative(rendererRoot, filePath))}`,
      personalPrefixes,
    ));
  }
  const nativeScanArtifacts = [];
  const nativeScanFindings = [];
  for (const nativeArtifact of nativeBundles.current) {
    const artifactScan = scanNativeInstallerRawAsciiUtf16Patterns(
      await readFile(path.join(runDirectory, nativeArtifact.artifact)),
      nativeArtifact.artifact,
      personalPrefixes,
    );
    nativeScanArtifacts.push({ path: nativeArtifact.artifact, status: artifactScan.status });
    nativeScanFindings.push(...artifactScan.findings);
  }
  scanFindings.push(...nativeScanFindings);
  const nativeInstallerRawAsciiUtf16PatternScan = {
    status: nativeScanFindings.length === 0 ? "PASS" : "FAIL",
    scope: "RAW_INSTALLER_FILE_BYTES_ONLY",
    encodings: ["ASCII", "UTF-16LE"],
    utf16LeByteAlignments: [0, 1],
    compressedPayloadCoverage: false,
    limitation: "COMPRESSED_OR_ENCRYPTED_PAYLOADS_NOT_INSPECTED",
    artifactsScanned: nativeScanArtifacts.length,
    artifacts: nativeScanArtifacts,
  };
  const desktopBundleManifest = {
    schemaVersion: "1.0",
    toolSpanVersion: packageDocument.version,
    sourceProvenance: sourceAfter,
    distProvenance,
    rendererBuild: "PASS",
    rendererFiles,
    nativeValidation: nativeBundles.status,
    nativeArtifacts: nativeBundles.current,
    staleNativeArtifactsExcluded: nativeBundles.stale,
    rejectedNativeArtifacts: nativeBundles.rejected,
    nativeInstallerRawAsciiUtf16PatternScan,
  };
  const artifactManifest = {
    schemaVersion: "1.0",
    status: "PASS",
    dryRunOnly: true,
    tagCreated: false,
    published: false,
    toolSpanVersion: packageDocument.version,
    generatedAt: createdAt,
    sourceProvenance: sourceAfter,
    distProvenance,
    npmPackage: {
      ...tarball,
      actualTarballTextContentScan: {
        status: packageScan.status,
        packageFilesEnumerated: packageScan.packageFilesEnumerated,
        packageFilesContentScanned: packageScan.packageFilesContentScanned,
        packageFilesBinarySkipped: packageScan.packageFilesBinarySkipped,
        packageFilesUnexplainedSkipped: packageScan.packageFilesUnexplainedSkipped,
      },
    },
    desktopRenderer: { status: "PASS", files: rendererFiles.length },
    desktopNative: {
      status: nativeBundles.status,
      artifacts: nativeBundles.current.length,
      staleArtifactsExcluded: nativeBundles.stale.length,
      rejectedArtifacts: nativeBundles.rejected.length,
      nativeInstallerRawAsciiUtf16PatternScan,
    },
    sbom: {
      status: "PASS",
      formats: ["SPDX-2.3", "CycloneDX-1.6"],
      components: components.length,
      inputs: inputHashes,
      cargoMetadata: "PASS",
      validation: {
        mode: sbomValidation.mode,
        spdx23: "PASS",
        cycloneDx16: "PASS",
      },
    },
  };
  for (const [generated, document] of [
    ["artifact-manifest.json", artifactManifest],
    ["desktop-bundles.manifest.json", desktopBundleManifest],
    ["sbom-validation.json", sbomValidation],
    ["sbom.spdx.json", emittedSpdx],
    ["sbom.cyclonedx.json", emittedCycloneDx],
  ]) {
    scanFindings.push(...scanReleaseText(JSON.stringify(document), generated, personalPrefixes));
  }
  const releaseScan = {
    status: scanFindings.length === 0 ? "PASS" : "FAIL",
    packageTextScanSource: tarball.path,
    packageBinaryCoverage: "EXPLICIT_MIME_AND_REASON_SKIPS_ONLY",
    packageFilesEnumerated: packageScan.packageFilesEnumerated,
    packageFilesContentScanned: packageScan.packageFilesContentScanned,
    packageFilesBinarySkipped: packageScan.packageFilesBinarySkipped,
    packageFilesUnexplainedSkipped: packageScan.packageFilesUnexplainedSkipped,
    packageFileContentScans: packageScan.packageFileContentScans,
    packageFileBinarySkipDetails: packageScan.packageFileBinarySkipDetails,
    nativeInstallerRawAsciiUtf16PatternScan: {
      ...nativeInstallerRawAsciiUtf16PatternScan,
      findings: nativeScanFindings,
    },
    secretValueFindings: scanFindings.filter((item) => item.code === "SECRET_LIKE_VALUE").length,
    personalPathFindings: scanFindings.filter((item) => item.code === "PERSONAL_ABSOLUTE_PATH").length,
    findings: scanFindings,
  };
  await writeJson(path.join(runDirectory, "release-scan.json"), releaseScan);
  if (scanFindings.length > 0) throw releaseError("RELEASE_SECRET_OR_PATH_SCAN_FAILED");

  await writeJson(path.join(runDirectory, "sbom.spdx.json"), emittedSpdx);
  await writeJson(path.join(runDirectory, "sbom.cyclonedx.json"), emittedCycloneDx);
  await writeJson(path.join(runDirectory, "sbom-validation.json"), sbomValidation);
  await writeJson(path.join(runDirectory, "desktop-bundles.manifest.json"), desktopBundleManifest);
  await writeJson(path.join(runDirectory, "artifact-manifest.json"), artifactManifest);

  const checksumFiles = [
    tarball.path,
    ...nativeBundles.current.map((entry) => entry.artifact),
    "artifact-manifest.json",
    "desktop-bundles.manifest.json",
    "release-scan.json",
    "sbom-validation.json",
    "sbom.spdx.json",
    "sbom.cyclonedx.json",
  ];
  const checksumLines = [];
  for (const relativePath of checksumFiles.sort()) {
    const checksum = await sha256File(path.join(runDirectory, relativePath));
    if (relativePath === tarball.path && checksum !== packageScan.tarballSha256) {
      throw releaseError("NPM_TARBALL_CHANGED_AFTER_SCAN");
    }
    checksumLines.push(`${checksum}  ${relativePath}`);
  }
  await writeFile(path.join(runDirectory, "checksums.sha256"), `${checksumLines.join("\n")}\n`, "utf8");
  await writeJson(path.join(releaseEvidenceRoot, "latest.json"), {
    schemaVersion: "1.0",
    status: "PASS",
    scope: "RELEASE_DRY_RUN_ASSEMBLY",
    dryRunOnly: true,
    runDirectory: runName,
    report: `${runName}/artifact-manifest.json`,
  });
  return {
    status: "PASS",
    dryRunOnly: true,
    tagCreated: false,
    published: false,
    packageFiles: packResult.files.length,
    packageFilesEnumerated: packageScan.packageFilesEnumerated,
    packageFilesContentScanned: packageScan.packageFilesContentScanned,
    packageFilesBinarySkipped: packageScan.packageFilesBinarySkipped,
    rendererFiles: rendererFiles.length,
    desktopNativeStatus: nativeBundles.status,
    staleNativeArtifactsExcluded: nativeBundles.stale.length,
    rejectedNativeArtifacts: nativeBundles.rejected.length,
    sbomComponents: components.length,
    secretValueFindings: 0,
    personalPathFindings: 0,
    evidence: `.toolspan-dev/evidence/release/${runName}`,
    exitCode: 0,
  };
}

async function main() {
  if (process.argv.length > 2) {
    process.stdout.write(`${JSON.stringify({ status: "FAIL", reason: "RELEASE_DRY_RUN_ACCEPTS_NO_ARGUMENTS" })}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const result = await runReleaseDryRun();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      status: error?.code === "NPM_CLI_NOT_FOUND" || error?.code === "CARGO_NOT_FOUND"
        ? "BLOCKED_BY_ENVIRONMENT" : "FAIL",
      reason: typeof error?.code === "string" ? error.code : "RELEASE_DRY_RUN_CRASHED",
      dryRunOnly: true,
      tagCreated: false,
      published: false,
    })}\n`);
    process.exitCode = error?.code === "NPM_CLI_NOT_FOUND" || error?.code === "CARGO_NOT_FOUND" ? 2 : 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
