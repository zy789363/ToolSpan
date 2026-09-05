import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { WorkspaceService } from "../workspaces/workspace-service.js";

const DEFAULT_LINE_LIMIT = 200;
const MAX_LINE_LIMIT = 1000;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_HASH_BYTES = 25 * 1024 * 1024;
const MAX_READ_MANY_FILES = 20;
const MAX_PATCH_OPERATIONS = 50;
const MAX_PATCH_NEW_BYTES = 5 * 1024 * 1024;
const MAX_TREE_ENTRIES = 10_000;
const MAX_TREE_BYTES = 256 * 1024 * 1024;
const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW;

export interface ReadFileInput {
  workspaceId: string;
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadFileResult {
  path: string;
  offset: number;
  lines: string[];
  nextOffset: number | null;
  totalLines: number;
}

export interface WriteFileInput {
  workspaceId: string;
  path: string;
  content: string;
}

export interface WriteFileResult {
  path: string;
  bytesWritten: number;
}

export interface EditFileInput {
  workspaceId: string;
  path: string;
  oldText: string;
  newText: string;
}

export interface EditFileResult {
  path: string;
  replacements: 1;
}

export interface ImportAssetInput {
  workspaceId: string;
  path: string;
  base64: string;
  mediaType: string;
}

export interface ImportAssetResult {
  path: string;
  mediaType: string;
  bytesWritten: number;
}

export interface SearchFilesInput {
  workspaceId: string;
  pattern: string;
  mode: "content" | "files";
  glob?: string;
  maxResults?: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface SearchFilesResult {
  matches: SearchMatch[];
  truncated: boolean;
}

export type FileSystemEntryType = "file" | "directory" | "symlink" | "other";

export interface ListDirectoryInput {
  workspaceId: string;
  path?: string;
  depth?: number;
  maxEntries?: number;
}

export interface DirectoryEntryResult {
  path: string;
  name: string;
  type: FileSystemEntryType;
  sizeBytes?: number;
  modifiedAt: string;
}

export interface ListDirectoryResult {
  path: string;
  entries: DirectoryEntryResult[];
  truncated: boolean;
}

export interface StatPathInput {
  workspaceId: string;
  path: string;
  includeSha256?: boolean;
}

export interface StatPathResult {
  path: string;
  type: FileSystemEntryType;
  sizeBytes: number;
  modifiedAt: string;
  createdAt: string;
  sha256?: string;
}

export interface MakeDirectoryInput {
  workspaceId: string;
  path: string;
  recursive?: boolean;
}

export interface MakeDirectoryResult {
  path: string;
  created: boolean;
}

export interface TransferPathInput {
  workspaceId: string;
  source: string;
  destination: string;
}

export interface TransferPathResult {
  source: string;
  destination: string;
  type: FileSystemEntryType;
  entries?: number;
  bytes?: number;
}

export interface DeletePathInput {
  workspaceId: string;
  path: string;
  recursive?: boolean;
  permanent?: boolean;
}

export interface DeletePathResult {
  path: string;
  type: FileSystemEntryType;
  permanent: boolean;
  deletedAt: string;
  entries?: number;
  bytes?: number;
  recoveryId?: string;
}

export interface RestorePathInput {
  workspaceId: string;
  recoveryId: string;
  destination?: string;
}

export interface RestorePathResult {
  recoveryId: string;
  originalPath: string;
  restoredPath: string;
  type: FileSystemEntryType;
  entries: number;
  bytes: number;
}

export interface ReadManyInput {
  workspaceId: string;
  files: Array<Omit<ReadFileInput, "workspaceId">>;
}

export interface ReadManyResult {
  files: ReadFileResult[];
}

export type PatchOperation =
  | { op: "create_file"; path: string; content: string }
  | { op: "edit_file"; path: string; oldText: string; newText: string }
  | { op: "delete_file"; path: string; expectedSha256: string };

export interface ApplyPatchInput {
  workspaceId: string;
  operations: PatchOperation[];
  dryRun?: boolean;
}

export interface PatchChangeResult {
  op: PatchOperation["op"];
  path: string;
  bytesBefore: number;
  bytesAfter: number;
}

export interface ApplyPatchResult {
  dryRun: boolean;
  applied: boolean;
  changes: PatchChangeResult[];
}

export interface FileServiceOptions {
  recoveryDirectory: string;
}

export interface FileService {
  read(input: ReadFileInput): Promise<ReadFileResult>;
  write(input: WriteFileInput): Promise<WriteFileResult>;
  edit(input: EditFileInput): Promise<EditFileResult>;
  searchFiles(input: SearchFilesInput): Promise<SearchFilesResult>;
  importAsset(input: ImportAssetInput): Promise<ImportAssetResult>;
  listDirectory(input: ListDirectoryInput): Promise<ListDirectoryResult>;
  statPath(input: StatPathInput): Promise<StatPathResult>;
  makeDirectory(input: MakeDirectoryInput): Promise<MakeDirectoryResult>;
  movePath(input: TransferPathInput): Promise<TransferPathResult>;
  copyPath(input: TransferPathInput): Promise<TransferPathResult>;
  deletePath(input: DeletePathInput): Promise<DeletePathResult>;
  restorePath(input: RestorePathInput): Promise<RestorePathResult>;
  readMany(input: ReadManyInput): Promise<ReadManyResult>;
  applyPatch(input: ApplyPatchInput): Promise<ApplyPatchResult>;
}

interface RipgrepMatchEvent {
  type: "match";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    submatches: Array<{ start: number }>;
  };
}

interface TreeMetrics {
  entries: number;
  bytes: number;
}

interface EntryFingerprint {
  dev: number | bigint;
  ino: number | bigint;
  mode: number | bigint;
  size: number | bigint;
  mtimeMs: number | bigint;
  ctimeMs: number | bigint;
}

interface TreeState extends TreeMetrics {
  fingerprints: Map<string, EntryFingerprint>;
}

interface OwnedEntry {
  path: string;
  type: FileSystemEntryType;
  fingerprint: EntryFingerprint;
}

interface RecoveryManifest extends TreeMetrics {
  version: 1;
  recoveryId: string;
  workspaceId: string;
  originalPath: string;
  type: FileSystemEntryType;
  deletedAt: string;
}

interface PreparedPatchOperation {
  operation: PatchOperation;
  targetPath: string;
  beforeContent?: string;
  afterContent?: string;
  beforeFingerprint?: EntryFingerprint;
  change: PatchChangeResult;
}

const pathLocks = new Map<string, Promise<void>>();

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function withPathLocks<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> {
  const keys = [...new Set(paths.map(comparisonPath))].sort((left, right) => left.localeCompare(right));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = keys.map((key) => pathLocks.get(key) ?? Promise.resolve());
  for (const key of keys) pathLocks.set(key, gate);
  await Promise.all(previous);
  try {
    return await operation();
  } finally {
    release();
    for (const key of keys) {
      if (pathLocks.get(key) === gate) pathLocks.delete(key);
    }
  }
}

async function withWorkspaceLock<T>(
  workspaces: WorkspaceService,
  workspaceId: string,
  extraPaths: readonly string[],
  operation: (workspaceRoot: string) => Promise<T>,
): Promise<T> {
  const workspaceRoot = await workspaces.resolveWorkspaceRoot(workspaceId);
  return withPathLocks([workspaceRoot, ...extraPaths], () => operation(workspaceRoot));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function comparisonPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function isWithin(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(comparisonPath(rootPath), comparisonPath(candidatePath));
  return relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

function normalizeToolPath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  return normalized === "" ? "." : normalized;
}

function joinToolPath(parent: string, child: string): string {
  return parent === "." ? child : `${parent}/${child}`;
}

function fileSystemType(stats: Awaited<ReturnType<typeof lstat>>): FileSystemEntryType {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  return "other";
}

function fingerprint(stats: Awaited<ReturnType<typeof lstat>>): EntryFingerprint {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function sameFingerprint(left: EntryFingerprint, right: EntryFingerprint): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameStableFingerprint(left: EntryFingerprint, right: EntryFingerprint): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function sameEntryIdentity(left: EntryFingerprint, right: EntryFingerprint): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

async function rememberOwnedEntry(
  entries: OwnedEntry[],
  targetPath: string,
  type: FileSystemEntryType,
): Promise<void> {
  entries.push({ path: targetPath, type, fingerprint: fingerprint(await lstat(targetPath)) });
}

async function removeOwnedEntry(entry: OwnedEntry): Promise<boolean> {
  let currentStats: Awaited<ReturnType<typeof lstat>>;
  try {
    currentStats = await lstat(entry.path);
  } catch (error) {
    if (isNotFound(error)) return true;
    throw error;
  }
  const currentFingerprint = fingerprint(currentStats);
  if (entry.type === "directory"
    ? !sameEntryIdentity(currentFingerprint, entry.fingerprint)
    : !sameStableFingerprint(currentFingerprint, entry.fingerprint)) return false;
  if (entry.type === "directory") {
    try {
      await rmdir(entry.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY"
        || (error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    }
  } else {
    await unlink(entry.path);
  }
  return true;
}

async function rollbackOwnedEntries(entries: readonly OwnedEntry[]): Promise<string[]> {
  const errors: string[] = [];
  for (const entry of [...entries].reverse()) {
    try {
      await removeOwnedEntry(entry);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "rollback failed");
    }
  }
  return errors;
}

function assertNotWorkspaceRoot(workspaceRoot: string, targetPath: string): void {
  if (comparisonPath(workspaceRoot) === comparisonPath(targetPath)) {
    throw new Error("The workspace root cannot be modified by this tool");
  }
}

function assertDirectoryDestination(sourcePath: string, destinationPath: string): void {
  if (isWithin(destinationPath, sourcePath)) {
    throw new Error("A directory cannot be copied or moved into itself");
  }
}

function assertUuid(value: string, fieldName: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(`${fieldName} must be a UUID`);
  }
}

async function runRipgrep(arguments_: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("rg", arguments_, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 10_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_READ_BYTES) child.kill();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0 || code === 1) {
        resolve(stdout);
      } else {
        reject(new Error(`ripgrep failed: ${stderr.trim() || `exit ${String(code)}`}`));
      }
    });
  });
}

async function atomicReplace(
  workspaces: WorkspaceService,
  workspaceId: string,
  relativePath: string,
  content: string,
  options: { expectedContent?: string; noReplace?: boolean } = {},
): Promise<void> {
  const targetPath = await workspaces.resolvePathForWrite(workspaceId, relativePath);
  const temporaryPath = path.join(path.dirname(targetPath), `.${randomUUID()}.tmp`);
  const temporaryEntries: OwnedEntry[] = [];
  let initialTarget: EntryFingerprint | undefined;
  try {
    try {
      initialTarget = fingerprint(await lstat(targetPath));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (options.noReplace && initialTarget !== undefined) {
      throw new Error("Target already exists");
    }
    if (options.expectedContent !== undefined) {
      const currentContent = await readBoundedText(targetPath);
      if (currentContent !== options.expectedContent) throw new Error("File changed during write");
    }
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await rememberOwnedEntry(temporaryEntries, temporaryPath, "file");
    const verifiedTarget = await workspaces.resolvePathForWrite(workspaceId, relativePath);
    if (comparisonPath(verifiedTarget) !== comparisonPath(targetPath)) {
      throw new Error("Path changed during write");
    }
    if (options.noReplace) {
      await link(temporaryPath, targetPath);
      await unlink(temporaryPath);
      temporaryEntries.length = 0;
      return;
    }
    if (options.expectedContent !== undefined) {
      if (initialTarget === undefined) throw new Error("File changed during write");
      const currentTarget = await lstat(targetPath);
      if (!sameFingerprint(fingerprint(currentTarget), initialTarget)) {
        throw new Error("File changed during write");
      }
      const currentContent = await readBoundedText(targetPath);
      if (currentContent !== options.expectedContent) throw new Error("File changed during write");
    }
    await rename(temporaryPath, targetPath);
    temporaryEntries.length = 0;
  } catch (error) {
    await rollbackOwnedEntries(temporaryEntries);
    throw error;
  }
}

async function atomicReplaceBytes(
  workspaces: WorkspaceService,
  workspaceId: string,
  relativePath: string,
  content: Buffer,
): Promise<void> {
  const targetPath = await workspaces.resolvePathForWrite(workspaceId, relativePath);
  const temporaryPath = path.join(path.dirname(targetPath), `.${randomUUID()}.tmp`);
  const temporaryEntries: OwnedEntry[] = [];
  try {
    await writeFile(temporaryPath, content, { flag: "wx" });
    await rememberOwnedEntry(temporaryEntries, temporaryPath, "file");
    const verifiedTarget = await workspaces.resolvePathForWrite(workspaceId, relativePath);
    if (comparisonPath(verifiedTarget) !== comparisonPath(targetPath)) {
      throw new Error("Path changed during write");
    }
    await rename(temporaryPath, targetPath);
    temporaryEntries.length = 0;
  } catch (error) {
    await rollbackOwnedEntries(temporaryEntries);
    throw error;
  }
}

async function readBoundedBuffer(targetPath: string, maximumBytes: number): Promise<Buffer> {
  const handle = await open(targetPath, "r");
  let content: Buffer;
  try {
    const fileStats = await handle.stat();
    if (!fileStats.isFile()) throw new Error("Path is not a regular file");
    if (fileStats.size > maximumBytes) {
      throw new Error(maximumBytes === MAX_READ_BYTES
        ? "File exceeds the 1 MiB read limit"
        : `File exceeds the ${String(maximumBytes)} byte read limit`);
    }
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const finalStats = await handle.stat();
    if (bytesRead > maximumBytes || finalStats.size > maximumBytes) {
      throw new Error(maximumBytes === MAX_READ_BYTES
        ? "File exceeds the 1 MiB read limit"
        : `File exceeds the ${String(maximumBytes)} byte read limit`);
    }
    content = Buffer.from(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
  return content;
}

async function readBoundedText(targetPath: string): Promise<string> {
  const content = (await readBoundedBuffer(targetPath, MAX_READ_BYTES)).toString("utf8");
  if (content.includes("\0")) throw new Error("Binary files are not supported");
  return content;
}

async function hashFile(targetPath: string, maximumBytes: number): Promise<string> {
  const fileStats = await lstat(targetPath);
  if (!fileStats.isFile()) throw new Error("SHA-256 is only available for regular files");
  if (fileStats.size > maximumBytes) {
    throw new Error(`File exceeds the ${String(maximumBytes)} byte hash limit`);
  }
  return createHash("sha256").update(await readBoundedBuffer(targetPath, maximumBytes)).digest("hex");
}

async function scanTree(
  targetPath: string,
  workspaceRoot?: string,
  validateLinkTargets = false,
): Promise<TreeMetrics> {
  let entries = 0;
  let bytes = 0;

  const visit = async (currentPath: string): Promise<void> => {
    const currentStats = await lstat(currentPath);
    entries += 1;
    if (entries > MAX_TREE_ENTRIES) throw new Error("Path exceeds the 10000 entry limit");
    if (currentStats.isFile()) {
      bytes += currentStats.size;
      if (bytes > MAX_TREE_BYTES) throw new Error("Path exceeds the 256 MiB copy limit");
      return;
    }
    if (currentStats.isSymbolicLink()) {
      if (validateLinkTargets && workspaceRoot !== undefined) {
        const canonicalTarget = await realpath(currentPath);
        if (!isWithin(canonicalTarget, workspaceRoot)) {
          throw new Error("Symbolic link target escapes workspace");
        }
      }
      return;
    }
    if (!currentStats.isDirectory()) throw new Error("Unsupported filesystem entry type");
    const canonicalCurrent = await realpath(currentPath);
    if (comparisonPath(canonicalCurrent) !== comparisonPath(currentPath)) {
      if (validateLinkTargets && workspaceRoot !== undefined && !isWithin(canonicalCurrent, workspaceRoot)) {
        throw new Error("Symbolic link target escapes workspace");
      }
      return;
    }
    if (workspaceRoot !== undefined && !isWithin(canonicalCurrent, workspaceRoot)) {
      throw new Error("Path escapes workspace");
    }
    const children = await readdir(currentPath);
    children.sort((left, right) => left.localeCompare(right, "en"));
    for (const child of children) await visit(path.join(currentPath, child));
  };

  await visit(targetPath);
  return { entries, bytes };
}

async function captureTreeState(
  targetPath: string,
  workspaceRoot?: string,
  validateLinkTargets = false,
): Promise<TreeState> {
  const fingerprints = new Map<string, EntryFingerprint>();
  let entries = 0;
  let bytes = 0;
  const visit = async (currentPath: string, relativePath: string): Promise<void> => {
    const currentStats = await lstat(currentPath);
    fingerprints.set(relativePath, fingerprint(currentStats));
    entries += 1;
    if (entries > MAX_TREE_ENTRIES) throw new Error("Path exceeds the 10000 entry limit");
    if (currentStats.isFile()) {
      bytes += currentStats.size;
      if (bytes > MAX_TREE_BYTES) throw new Error("Path exceeds the 256 MiB copy limit");
      return;
    }
    if (currentStats.isSymbolicLink()) {
      if (validateLinkTargets && workspaceRoot !== undefined
        && !isWithin(await realpath(currentPath), workspaceRoot)) {
        throw new Error("Symbolic link target escapes workspace");
      }
      return;
    }
    if (!currentStats.isDirectory()) throw new Error("Unsupported filesystem entry type");
    const canonicalCurrent = await realpath(currentPath);
    if (comparisonPath(canonicalCurrent) !== comparisonPath(currentPath)) {
      if (validateLinkTargets && workspaceRoot !== undefined && !isWithin(canonicalCurrent, workspaceRoot)) {
        throw new Error("Symbolic link target escapes workspace");
      }
      return;
    }
    if (workspaceRoot !== undefined && !isWithin(canonicalCurrent, workspaceRoot)) {
      throw new Error("Path escapes workspace");
    }
    const children = await readdir(currentPath);
    children.sort((left, right) => left.localeCompare(right, "en"));
    for (const child of children) {
      await visit(path.join(currentPath, child), relativePath === ""
        ? child
        : path.join(relativePath, child));
    }
  };
  await visit(targetPath, "");
  return { entries, bytes, fingerprints };
}

function sameTreeState(left: TreeState, right: TreeState): boolean {
  if (left.entries !== right.entries || left.bytes !== right.bytes
    || left.fingerprints.size !== right.fingerprints.size) return false;
  for (const [relativePath, leftFingerprint] of left.fingerprints) {
    const rightFingerprint = right.fingerprints.get(relativePath);
    if (rightFingerprint === undefined || !sameStableFingerprint(leftFingerprint, rightFingerprint)) return false;
  }
  return true;
}

async function reparseTarget(
  sourcePath: string,
  sourceStats: Awaited<ReturnType<typeof lstat>>,
): Promise<string | undefined> {
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) return undefined;
  const canonicalTarget = await realpath(sourcePath);
  return comparisonPath(canonicalTarget) === comparisonPath(sourcePath)
    ? undefined
    : canonicalTarget;
}

async function symlinkType(sourcePath: string): Promise<"file" | "junction" | undefined> {
  if (process.platform !== "win32") return undefined;
  try {
    return (await stat(sourcePath)).isDirectory() ? "junction" : "file";
  } catch (error) {
    if (isNotFound(error)) return "file";
    throw error;
  }
}

async function copySymlink(sourcePath: string, destinationPath: string): Promise<void> {
  const linkTarget = await readlink(sourcePath);
  const copiedTarget = path.isAbsolute(linkTarget)
    ? linkTarget
    : path.relative(
      path.dirname(destinationPath),
      path.resolve(path.dirname(sourcePath), linkTarget),
    ) || ".";
  await symlink(copiedTarget, destinationPath, await symlinkType(sourcePath));
}

async function moveSymlink(sourcePath: string, destinationPath: string): Promise<void> {
  await symlink(await readlink(sourcePath), destinationPath, await symlinkType(sourcePath));
}

async function copyRegularFile(sourcePath: string, destinationPath: string): Promise<void> {
  const sourceHandle = await open(
    sourcePath,
    O_NOFOLLOW === undefined ? "r" : fsConstants.O_RDONLY | O_NOFOLLOW,
  );
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const sourceStats = await sourceHandle.stat();
    if (!sourceStats.isFile()) throw new Error("Path is not a regular file");
    destinationHandle = await open(
      destinationPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      sourceStats.mode & 0o777,
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      await destinationHandle.write(buffer, 0, bytesRead);
    }
  } finally {
    await destinationHandle?.close();
    await sourceHandle.close();
  }
}

async function copyEntry(
  sourcePath: string,
  destinationPath: string,
  workspaceRoot?: string,
  validateLinkTargets = false,
  ownedEntries: OwnedEntry[] = [],
): Promise<void> {
  const sourceStats = await lstat(sourcePath);
  if (sourceStats.isFile()) {
    await copyRegularFile(sourcePath, destinationPath);
    await rememberOwnedEntry(ownedEntries, destinationPath, "file");
    return;
  }
  if (sourceStats.isSymbolicLink()) {
    if (validateLinkTargets && workspaceRoot !== undefined) {
      const canonicalTarget = await realpath(sourcePath);
      if (!isWithin(canonicalTarget, workspaceRoot)) {
        throw new Error("Symbolic link target escapes workspace");
      }
    }
    await copySymlink(sourcePath, destinationPath);
    await rememberOwnedEntry(ownedEntries, destinationPath, "symlink");
    return;
  }
  const reparse = await reparseTarget(sourcePath, sourceStats);
  if (reparse !== undefined) {
    if (validateLinkTargets && workspaceRoot !== undefined && !isWithin(reparse, workspaceRoot)) {
      throw new Error("Symbolic link target escapes workspace");
    }
    await copySymlink(sourcePath, destinationPath);
    await rememberOwnedEntry(ownedEntries, destinationPath, "symlink");
    return;
  }
  if (!sourceStats.isDirectory()) throw new Error("Unsupported filesystem entry type");

  await mkdir(destinationPath);
  await rememberOwnedEntry(ownedEntries, destinationPath, "directory");
  const children = await readdir(sourcePath);
  children.sort((left, right) => left.localeCompare(right, "en"));
  for (const child of children) {
    await copyEntry(
      path.join(sourcePath, child),
      path.join(destinationPath, child),
      workspaceRoot,
      validateLinkTargets,
      ownedEntries,
    );
  }
}

async function commitStagedEntry(stagedPath: string, destinationPath: string): Promise<void> {
  const ownedEntries: OwnedEntry[] = [];
  const commit = async (sourcePath: string, targetPath: string): Promise<void> => {
    const sourceStats = await lstat(sourcePath);
    if (sourceStats.isFile()) {
      await link(sourcePath, targetPath);
      await rememberOwnedEntry(ownedEntries, targetPath, "file");
      return;
    }
    if (sourceStats.isSymbolicLink()) {
      await copySymlink(sourcePath, targetPath);
      await rememberOwnedEntry(ownedEntries, targetPath, "symlink");
      return;
    }
    const reparse = await reparseTarget(sourcePath, sourceStats);
    if (reparse !== undefined) {
      await copySymlink(sourcePath, targetPath);
      await rememberOwnedEntry(ownedEntries, targetPath, "symlink");
      return;
    }
    if (!sourceStats.isDirectory()) throw new Error("Unsupported filesystem entry type");
    await mkdir(targetPath);
    await rememberOwnedEntry(ownedEntries, targetPath, "directory");
    const children = await readdir(sourcePath);
    children.sort((left, right) => left.localeCompare(right, "en"));
    for (const child of children) {
      await commit(path.join(sourcePath, child), path.join(targetPath, child));
    }
  };

  try {
    await commit(stagedPath, destinationPath);
  } catch (error) {
    const rollbackErrors = await rollbackOwnedEntries(ownedEntries);
    if (rollbackErrors.length > 0) {
      const originalMessage = error instanceof Error ? error.message : "staged commit failed";
      throw new Error(`${originalMessage}; rollback errors: ${rollbackErrors.join("; ")}`);
    }
    throw error;
  }
}

async function moveEntryNoReplace(
  sourcePath: string,
  destinationPath: string,
  expectedState: TreeState,
): Promise<void> {
  const ownedEntries: OwnedEntry[] = [];
  const copyForMove = async (source: string, target: string): Promise<void> => {
    const sourceStats = await lstat(source);
    if (sourceStats.isFile()) {
      await link(source, target);
      await rememberOwnedEntry(ownedEntries, target, "file");
      return;
    }
    if (sourceStats.isSymbolicLink()) {
      await moveSymlink(source, target);
      await rememberOwnedEntry(ownedEntries, target, "symlink");
      return;
    }
    const reparse = await reparseTarget(source, sourceStats);
    if (reparse !== undefined) {
      await moveSymlink(source, target);
      await rememberOwnedEntry(ownedEntries, target, "symlink");
      return;
    }
    if (!sourceStats.isDirectory()) throw new Error("Unsupported filesystem entry type");
    await mkdir(target);
    await rememberOwnedEntry(ownedEntries, target, "directory");
    const children = await readdir(source);
    children.sort((left, right) => left.localeCompare(right, "en"));
    for (const child of children) {
      await copyForMove(path.join(source, child), path.join(target, child));
    }
  };

  try {
    await copyForMove(sourcePath, destinationPath);
    const currentState = await captureTreeState(sourcePath);
    if (!sameTreeState(currentState, expectedState)) {
      throw new Error("Source changed during move");
    }
    await removeEntry(sourcePath, true);
  } catch (error) {
    const rollbackErrors = await rollbackOwnedEntries(ownedEntries);
    if (rollbackErrors.length > 0) {
      const originalMessage = error instanceof Error ? error.message : "move failed";
      throw new Error(`${originalMessage}; rollback errors: ${rollbackErrors.join("; ")}`);
    }
    throw error;
  }
}

async function removeEntry(targetPath: string, recursive: boolean): Promise<void> {
  const targetStats = await lstat(targetPath);
  if (targetStats.isDirectory() && !targetStats.isSymbolicLink()
    && await reparseTarget(targetPath, targetStats) === undefined) {
    if (!recursive) {
      await rmdir(targetPath);
      return;
    }
    const children = await readdir(targetPath);
    for (const child of children) await removeEntry(path.join(targetPath, child), true);
    await rmdir(targetPath);
    return;
  }
  await unlink(targetPath);
}

function recoveryManifest(value: unknown): RecoveryManifest {
  if (typeof value !== "object" || value === null) throw new Error("Invalid recovery manifest");
  const manifest = value as Partial<RecoveryManifest>;
  if (
    manifest.version !== 1
    || typeof manifest.recoveryId !== "string"
    || typeof manifest.workspaceId !== "string"
    || typeof manifest.originalPath !== "string"
    || !["file", "directory", "symlink", "other"].includes(String(manifest.type))
    || typeof manifest.deletedAt !== "string"
    || typeof manifest.entries !== "number"
    || typeof manifest.bytes !== "number"
  ) {
    throw new Error("Invalid recovery manifest");
  }
  return manifest as RecoveryManifest;
}

export function createFileService(
  workspaces: WorkspaceService,
  options: FileServiceOptions,
): FileService {
  const recoveryDirectory = path.resolve(options.recoveryDirectory);

  const read = async (input: ReadFileInput): Promise<ReadFileResult> => {
    const offset = input.offset ?? 0;
    const limit = input.limit ?? DEFAULT_LINE_LIMIT;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error("offset must be a non-negative integer");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LINE_LIMIT) {
      throw new Error(`limit must be between 1 and ${MAX_LINE_LIMIT}`);
    }

    const canonicalPath = await workspaces.resolveExistingPath(input.workspaceId, input.path);
    const content = await readBoundedText(canonicalPath);
    const allLines = content.split(/\r?\n/u);
    const lines = allLines.slice(offset, offset + limit);
    const nextOffset = offset + lines.length < allLines.length ? offset + lines.length : null;
    return {
      path: normalizeToolPath(input.path),
      offset,
      lines,
      nextOffset,
      totalLines: allLines.length,
    };
  };

  return {
    read,

    async write(input: WriteFileInput): Promise<WriteFileResult> {
      const bytesWritten = Buffer.byteLength(input.content, "utf8");
      if (bytesWritten > MAX_WRITE_BYTES) throw new Error("Content exceeds the 1 MiB write limit");
      await withWorkspaceLock(workspaces, input.workspaceId, [], async () => {
        await atomicReplace(workspaces, input.workspaceId, input.path, input.content);
      });
      return { path: normalizeToolPath(input.path), bytesWritten };
    },

    async edit(input: EditFileInput): Promise<EditFileResult> {
      if (input.oldText.length === 0) throw new Error("oldText must not be empty");
      await withWorkspaceLock(workspaces, input.workspaceId, [], async () => {
        const existingPath = await workspaces.resolveExistingPath(input.workspaceId, input.path);
        const content = await readBoundedText(existingPath);
        const occurrences = content.split(input.oldText).length - 1;
        if (occurrences !== 1) {
          throw new Error(`oldText must occur exactly once; found ${occurrences}`);
        }
        const updatedContent = content.replace(input.oldText, input.newText);
        if (Buffer.byteLength(updatedContent, "utf8") > MAX_WRITE_BYTES) {
          throw new Error("Edited content exceeds the 1 MiB write limit");
        }
        await atomicReplace(workspaces, input.workspaceId, input.path, updatedContent, { expectedContent: content });
      });
      return { path: normalizeToolPath(input.path), replacements: 1 };
    },

    async searchFiles(input: SearchFilesInput): Promise<SearchFilesResult> {
      const maxResults = input.maxResults ?? 50;
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 200) {
        throw new Error("maxResults must be between 1 and 200");
      }
      if (input.pattern.length === 0 || input.pattern.length > 1000) {
        throw new Error("pattern length must be between 1 and 1000 characters");
      }
      const root = await workspaces.resolveWorkspaceRoot(input.workspaceId);
      if (input.mode === "files") {
        const output = await runRipgrep(["--files", "--glob", input.pattern], root);
        const paths = output
          .split(/\r?\n/u)
          .filter((line) => line.length > 0)
          .map((line) => line.replaceAll("\\", "/"));
        return {
          matches: paths.slice(0, maxResults).map((filePath) => ({
            path: filePath,
            line: 0,
            column: 0,
            text: "",
          })),
          truncated: paths.length > maxResults,
        };
      }

      const arguments_ = ["--json", "--color", "never"];
      if (input.glob !== undefined) arguments_.push("--glob", input.glob);
      arguments_.push("--regexp", input.pattern, ".");
      const output = await runRipgrep(arguments_, root);
      const matches: SearchMatch[] = [];
      for (const line of output.split(/\r?\n/u)) {
        if (line.length === 0) continue;
        const event = JSON.parse(line) as RipgrepMatchEvent | { type: string };
        if (event.type !== "match") continue;
        const match = event as RipgrepMatchEvent;
        matches.push({
          path: match.data.path.text.replaceAll("\\", "/").replace(/^\.\//u, ""),
          line: match.data.line_number,
          column: (match.data.submatches[0]?.start ?? 0) + 1,
          text: match.data.lines.text.replace(/\r?\n$/u, ""),
        });
        if (matches.length > maxResults) break;
      }
      return { matches: matches.slice(0, maxResults), truncated: matches.length > maxResults };
    },

    async importAsset(input: ImportAssetInput): Promise<ImportAssetResult> {
      if (!/^[\w.+-]+\/[\w.+-]+$/u.test(input.mediaType)) {
        throw new Error("mediaType must be a valid MIME type");
      }
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(input.base64)) {
        throw new Error("base64 must be canonical base64 data");
      }
      if (input.base64.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4) {
        throw new Error("Asset exceeds the 25 MiB import limit");
      }
      const bytes = Buffer.from(input.base64, "base64");
      if (bytes.length > MAX_ASSET_BYTES) throw new Error("Asset exceeds the 25 MiB import limit");
      await withWorkspaceLock(workspaces, input.workspaceId, [], async () => {
        await atomicReplaceBytes(workspaces, input.workspaceId, input.path, bytes);
      });
      return {
        path: normalizeToolPath(input.path),
        mediaType: input.mediaType,
        bytesWritten: bytes.length,
      };
    },

    async listDirectory(input: ListDirectoryInput): Promise<ListDirectoryResult> {
      const relativePath = input.path ?? ".";
      const depth = input.depth ?? 1;
      const maxEntries = input.maxEntries ?? 200;
      if (!Number.isInteger(depth) || depth < 1 || depth > 5) {
        throw new Error("depth must be between 1 and 5");
      }
      if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000) {
        throw new Error("maxEntries must be between 1 and 1000");
      }
      const directoryPath = await workspaces.resolveEntryPath(input.workspaceId, relativePath);
      const directoryStats = await lstat(directoryPath);
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
        throw new Error("Path is not a directory");
      }

      const rootToolPath = normalizeToolPath(relativePath);
      const collected: DirectoryEntryResult[] = [];
      const visit = async (currentPath: string, currentToolPath: string, level: number): Promise<void> => {
        const children = await readdir(currentPath);
        children.sort((left, right) => left.localeCompare(right, "en"));
        for (const child of children) {
          if (collected.length > maxEntries) return;
          const childPath = path.join(currentPath, child);
          const childStats = await lstat(childPath);
          const childToolPath = joinToolPath(currentToolPath, child);
          collected.push({
            path: childToolPath,
            name: child,
            type: fileSystemType(childStats),
            ...(childStats.isFile() ? { sizeBytes: childStats.size } : {}),
            modifiedAt: childStats.mtime.toISOString(),
          });
          if (childStats.isDirectory() && !childStats.isSymbolicLink() && level < depth) {
            await visit(childPath, childToolPath, level + 1);
          }
        }
      };

      await visit(directoryPath, rootToolPath, 1);
      return {
        path: rootToolPath,
        entries: collected.slice(0, maxEntries),
        truncated: collected.length > maxEntries,
      };
    },

    async statPath(input: StatPathInput): Promise<StatPathResult> {
      const targetPath = await workspaces.resolveEntryPath(input.workspaceId, input.path);
      const targetStats = await lstat(targetPath);
      const result: StatPathResult = {
        path: normalizeToolPath(input.path),
        type: fileSystemType(targetStats),
        sizeBytes: targetStats.size,
        modifiedAt: targetStats.mtime.toISOString(),
        createdAt: targetStats.birthtime.toISOString(),
      };
      if (input.includeSha256 === true && targetStats.isFile()) {
        result.sha256 = await hashFile(targetPath, MAX_HASH_BYTES);
      }
      return result;
    },

    async makeDirectory(input: MakeDirectoryInput): Promise<MakeDirectoryResult> {
      return withWorkspaceLock(workspaces, input.workspaceId, [], async (workspaceRoot) => {
        const targetPath = await workspaces.resolvePathForCreate(input.workspaceId, input.path);
        assertNotWorkspaceRoot(workspaceRoot, targetPath);
        try {
          const existingStats = await lstat(targetPath);
          if (!existingStats.isDirectory() || existingStats.isSymbolicLink()) {
            throw new Error("Path already exists and is not a directory");
          }
          return { path: normalizeToolPath(input.path), created: false };
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }

        const createdEntries: OwnedEntry[] = [];
        let targetCreated = false;
        try {
          if (input.recursive === false) {
            try {
              await mkdir(targetPath);
              await rememberOwnedEntry(createdEntries, targetPath, "directory");
              targetCreated = true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
              const existingStats = await lstat(targetPath);
              if (!existingStats.isDirectory() || existingStats.isSymbolicLink()) {
                throw new Error("Path already exists and is not a directory");
              }
              return { path: normalizeToolPath(input.path), created: false };
            }
          } else {
            const missing: string[] = [];
            let ancestor = targetPath;
            while (true) {
              try {
                const ancestorStats = await lstat(ancestor);
                if (!ancestorStats.isDirectory() || ancestorStats.isSymbolicLink()) {
                  throw new Error("Path already exists and is not a directory");
                }
                break;
              } catch (error) {
                if (!isNotFound(error)) throw error;
                missing.push(path.basename(ancestor));
                const parent = path.dirname(ancestor);
                if (parent === ancestor) throw new Error("Path escapes workspace");
                ancestor = parent;
              }
            }
            for (const segment of missing.reverse()) {
              const next = path.join(ancestor, segment);
              try {
                await mkdir(next);
                await rememberOwnedEntry(createdEntries, next, "directory");
                if (comparisonPath(next) === comparisonPath(targetPath)) targetCreated = true;
              } catch (error) {
                if (!isNotFound(error) && (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                const nextStats = await lstat(next);
                if (!nextStats.isDirectory() || nextStats.isSymbolicLink()) {
                  throw new Error("Path already exists and is not a directory");
                }
              }
              ancestor = next;
            }
          }
        } catch (error) {
          await rollbackOwnedEntries(createdEntries);
          throw error;
        }
        try {
          await workspaces.resolveExistingPath(input.workspaceId, input.path);
        } catch (error) {
          await rollbackOwnedEntries(createdEntries);
          throw error;
        }
        return { path: normalizeToolPath(input.path), created: targetCreated };
      });
    },

    async movePath(input: TransferPathInput): Promise<TransferPathResult> {
      return withWorkspaceLock(workspaces, input.workspaceId, [], async (workspaceRoot) => {
        const sourcePath = await workspaces.resolveEntryPath(input.workspaceId, input.source);
        const destinationPath = await workspaces.resolvePathForWrite(input.workspaceId, input.destination);
        assertNotWorkspaceRoot(workspaceRoot, sourcePath);
        assertNotWorkspaceRoot(workspaceRoot, destinationPath);
        if (await pathExists(destinationPath)) throw new Error("Destination already exists");
        const sourceStats = await lstat(sourcePath);
        if (sourceStats.isDirectory() && !sourceStats.isSymbolicLink()) {
          assertDirectoryDestination(sourcePath, destinationPath);
        }
        const sourceState = await captureTreeState(sourcePath);

        const verifiedSource = await workspaces.resolveEntryPath(input.workspaceId, input.source);
        const verifiedDestination = await workspaces.resolvePathForWrite(input.workspaceId, input.destination);
        if (
          comparisonPath(verifiedSource) !== comparisonPath(sourcePath)
          || comparisonPath(verifiedDestination) !== comparisonPath(destinationPath)
        ) {
          throw new Error("Path changed during move");
        }
        await moveEntryNoReplace(sourcePath, destinationPath, sourceState);
        return {
          source: normalizeToolPath(input.source),
          destination: normalizeToolPath(input.destination),
          type: fileSystemType(sourceStats),
          entries: sourceState.entries,
          bytes: sourceState.bytes,
        };
      });
    },

    async copyPath(input: TransferPathInput): Promise<TransferPathResult> {
      return withWorkspaceLock(workspaces, input.workspaceId, [], async (workspaceRoot) => {
        const sourcePath = await workspaces.resolveEntryPath(input.workspaceId, input.source);
        const destinationPath = await workspaces.resolvePathForWrite(input.workspaceId, input.destination);
        assertNotWorkspaceRoot(workspaceRoot, sourcePath);
        assertNotWorkspaceRoot(workspaceRoot, destinationPath);
        if (await pathExists(destinationPath)) throw new Error("Destination already exists");
        const sourceStats = await lstat(sourcePath);
        if (sourceStats.isDirectory() && !sourceStats.isSymbolicLink()) {
          assertDirectoryDestination(sourcePath, destinationPath);
        }
        const sourceState = await captureTreeState(sourcePath, workspaceRoot, true);
        const stagingPath = path.join(path.dirname(destinationPath), `.${randomUUID()}.webgpt-copy`);
        const stagingEntries: OwnedEntry[] = [];
        try {
          await copyEntry(sourcePath, stagingPath, workspaceRoot, true, stagingEntries);
          if (!sameTreeState(await captureTreeState(sourcePath, workspaceRoot, true), sourceState)) {
            throw new Error("Source changed during copy");
          }
          await commitStagedEntry(stagingPath, destinationPath);
        } catch (error) {
          const cleanupErrors = await rollbackOwnedEntries(stagingEntries);
          if (cleanupErrors.length > 0) {
            const originalMessage = error instanceof Error ? error.message : "copy failed";
            throw new Error(`${originalMessage}; cleanup errors: ${cleanupErrors.join("; ")}`);
          }
          throw error;
        }
        const cleanupErrors = await rollbackOwnedEntries(stagingEntries);
        if (cleanupErrors.length > 0) {
          throw new Error(`Copy staging cleanup failed: ${cleanupErrors.join("; ")}`);
        }
        return {
          source: normalizeToolPath(input.source),
          destination: normalizeToolPath(input.destination),
          type: fileSystemType(sourceStats),
          entries: sourceState.entries,
          bytes: sourceState.bytes,
        };
      });
    },

    async deletePath(input: DeletePathInput): Promise<DeletePathResult> {
      assertUuid(input.workspaceId, "workspaceId");
      return withWorkspaceLock(workspaces, input.workspaceId, [], async (workspaceRoot) => {
        const sourcePath = await workspaces.resolveEntryPath(input.workspaceId, input.path);
        assertNotWorkspaceRoot(workspaceRoot, sourcePath);
        const sourceStats = await lstat(sourcePath);
        const sourceType = fileSystemType(sourceStats);
        const recursive = input.recursive ?? false;
        if (sourceStats.isDirectory() && !sourceStats.isSymbolicLink() && !recursive) {
          if ((await readdir(sourcePath)).length > 0) {
            throw new Error("Non-empty directories require recursive=true");
          }
        }
        const sourceState = await captureTreeState(sourcePath);
        const verifySource = async (): Promise<void> => {
          const verifiedSource = await workspaces.resolveEntryPath(input.workspaceId, input.path);
          if (comparisonPath(verifiedSource) !== comparisonPath(sourcePath)
            || !sameTreeState(await captureTreeState(sourcePath), sourceState)) {
            throw new Error("Path changed during delete");
          }
        };
        const deletedAt = new Date().toISOString();
        if (input.permanent === true) {
          await verifySource();
          const localStagingPath = path.join(path.dirname(sourcePath), `.${randomUUID()}.webgpt-delete`);
          let moved = false;
          try {
            await rename(sourcePath, localStagingPath);
            moved = true;
            if (!sameTreeState(await captureTreeState(localStagingPath), sourceState)) {
              throw new Error("Path changed during delete");
            }
            await removeEntry(localStagingPath, true);
          } catch (error) {
            if (moved) {
              try {
                const currentState = await captureTreeState(localStagingPath);
                await moveEntryNoReplace(localStagingPath, sourcePath, currentState);
              } catch {
                // Keep the staging path as a recoverable fail-safe when the original path is contested.
              }
            }
            throw error;
          }
          return {
            path: normalizeToolPath(input.path),
            type: sourceType,
            permanent: true,
            deletedAt,
            entries: sourceState.entries,
            bytes: sourceState.bytes,
          };
        }

        const recoveryId = randomUUID();
        const workspaceRecoveryDirectory = path.join(recoveryDirectory, input.workspaceId);
        const finalRecoveryPath = path.join(workspaceRecoveryDirectory, recoveryId);
        const stagedRecoveryPath = path.join(workspaceRecoveryDirectory, `.${recoveryId}.${randomUUID()}.tmp`);
        const payloadPath = path.join(stagedRecoveryPath, "payload");
        await mkdir(workspaceRecoveryDirectory, { recursive: true });
        const stagingEntries: OwnedEntry[] = [];
        let recoveryCommitted = false;
        let committedRecoveryState: TreeState | undefined;
        let localStagingPath: string | undefined;
        try {
          await mkdir(stagedRecoveryPath);
          await rememberOwnedEntry(stagingEntries, stagedRecoveryPath, "directory");
          await copyEntry(sourcePath, payloadPath, undefined, false, stagingEntries);
          const copiedMetrics = await scanTree(payloadPath);
          if (copiedMetrics.entries !== sourceState.entries || copiedMetrics.bytes !== sourceState.bytes) {
            throw new Error("Recovery copy verification failed");
          }
          await verifySource();
          const manifest: RecoveryManifest = {
            version: 1,
            recoveryId,
            workspaceId: input.workspaceId,
            originalPath: normalizeToolPath(input.path),
            type: sourceType,
            deletedAt,
            entries: sourceState.entries,
            bytes: sourceState.bytes,
          };
          const manifestPath = path.join(stagedRecoveryPath, "manifest.json");
          await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
          });
          await rememberOwnedEntry(stagingEntries, manifestPath, "file");
          if (await pathExists(finalRecoveryPath)) throw new Error("Recovery record already exists");
          await rename(stagedRecoveryPath, finalRecoveryPath);
          recoveryCommitted = true;
          committedRecoveryState = await captureTreeState(finalRecoveryPath);
          localStagingPath = path.join(path.dirname(sourcePath), `.${randomUUID()}.webgpt-delete`);
          await verifySource();
          await rename(sourcePath, localStagingPath);
          if (!sameTreeState(await captureTreeState(localStagingPath), sourceState)) {
            throw new Error("Path changed during delete");
          }
          await removeEntry(localStagingPath, true);
        } catch (error) {
          if (localStagingPath !== undefined) {
            try {
              const currentState = await captureTreeState(localStagingPath);
              await moveEntryNoReplace(localStagingPath, sourcePath, currentState);
            } catch {
              // Preserve contested data in the staging path and recovery record.
            }
          }
          if (recoveryCommitted && committedRecoveryState !== undefined) {
            try {
              if (sameTreeState(await captureTreeState(finalRecoveryPath), committedRecoveryState)) {
                await removeEntry(finalRecoveryPath, true);
              }
            } catch {
              // Fail safe: leave the recovery record when its ownership is uncertain.
            }
          } else {
            await rollbackOwnedEntries(stagingEntries);
          }
          throw error;
        }

        return {
          path: normalizeToolPath(input.path),
          type: sourceType,
          permanent: false,
          deletedAt,
          recoveryId,
          entries: sourceState.entries,
          bytes: sourceState.bytes,
        };
      });
    },

    async restorePath(input: RestorePathInput): Promise<RestorePathResult> {
      assertUuid(input.workspaceId, "workspaceId");
      assertUuid(input.recoveryId, "recoveryId");
      const recoveryPath = path.join(recoveryDirectory, input.workspaceId, input.recoveryId);
      const manifest = recoveryManifest(JSON.parse(await readFile(path.join(recoveryPath, "manifest.json"), "utf8")));
      if (manifest.workspaceId !== input.workspaceId || manifest.recoveryId !== input.recoveryId) {
        throw new Error("Recovery record does not belong to this workspace");
      }
      const destination = input.destination ?? manifest.originalPath;
      return withWorkspaceLock(workspaces, input.workspaceId, [recoveryPath], async (workspaceRoot) => {
        const destinationPath = await workspaces.resolvePathForWrite(input.workspaceId, destination);
        assertNotWorkspaceRoot(workspaceRoot, destinationPath);
        if (await pathExists(destinationPath)) throw new Error("Restore destination already exists");

        const payloadPath = path.join(recoveryPath, "payload");
        const metrics = await scanTree(payloadPath);
        if (metrics.entries !== manifest.entries || metrics.bytes !== manifest.bytes) {
          throw new Error("Recovery payload verification failed");
        }
        const stagedDestination = path.join(path.dirname(destinationPath), `.${randomUUID()}.webgpt-restore`);
        const stagingEntries: OwnedEntry[] = [];
        try {
          await copyEntry(payloadPath, stagedDestination, undefined, false, stagingEntries);
          await commitStagedEntry(stagedDestination, destinationPath);
        } catch (error) {
          const cleanupErrors = await rollbackOwnedEntries(stagingEntries);
          if (cleanupErrors.length > 0) {
            const originalMessage = error instanceof Error ? error.message : "restore failed";
            throw new Error(`${originalMessage}; cleanup errors: ${cleanupErrors.join("; ")}`);
          }
          throw error;
        }
        const cleanupErrors = await rollbackOwnedEntries(stagingEntries);
        if (cleanupErrors.length > 0) {
          throw new Error(`Restore staging cleanup failed: ${cleanupErrors.join("; ")}`);
        }
        await removeEntry(recoveryPath, true);
        return {
          recoveryId: input.recoveryId,
          originalPath: manifest.originalPath,
          restoredPath: normalizeToolPath(destination),
          type: manifest.type,
          ...metrics,
        };
      });
    },

    async readMany(input: ReadManyInput): Promise<ReadManyResult> {
      if (input.files.length < 1 || input.files.length > MAX_READ_MANY_FILES) {
        throw new Error(`files must contain between 1 and ${MAX_READ_MANY_FILES} items`);
      }
      const results: ReadFileResult[] = [];
      let totalBytes = 0;
      for (const file of input.files) {
        const result = await read({ workspaceId: input.workspaceId, ...file });
        totalBytes += Buffer.byteLength(result.lines.join("\n"), "utf8");
        if (totalBytes > MAX_READ_BYTES) {
          throw new Error("Combined read_many content exceeds the 1 MiB response limit");
        }
        results.push(result);
      }
      return { files: results };
    },

    async applyPatch(input: ApplyPatchInput): Promise<ApplyPatchResult> {
      if (!Array.isArray(input.operations)
        || input.operations.length < 1 || input.operations.length > MAX_PATCH_OPERATIONS) {
        throw new Error(`operations must contain between 1 and ${MAX_PATCH_OPERATIONS} items`);
      }
      return withWorkspaceLock(workspaces, input.workspaceId, [], async () => {
      const seenPaths = new Set<string>();
      const prepared: PreparedPatchOperation[] = [];
      let totalNewBytes = 0;

      for (const operation of input.operations) {
        const normalizedPath = normalizeToolPath(operation.path);
        const comparison = process.platform === "win32"
          ? normalizedPath.toLocaleLowerCase("en-US")
          : normalizedPath;
        if (seenPaths.has(comparison)) throw new Error(`Patch path appears more than once: ${normalizedPath}`);
        seenPaths.add(comparison);

        if (operation.op === "create_file") {
          const bytesAfter = Buffer.byteLength(operation.content, "utf8");
          if (bytesAfter > MAX_WRITE_BYTES) throw new Error(`Patch file exceeds 1 MiB: ${normalizedPath}`);
          const targetPath = await workspaces.resolvePathForWrite(input.workspaceId, operation.path);
          if (await pathExists(targetPath)) throw new Error(`Patch create target already exists: ${normalizedPath}`);
          totalNewBytes += bytesAfter;
          prepared.push({
            operation,
            targetPath,
            afterContent: operation.content,
            change: { op: operation.op, path: normalizedPath, bytesBefore: 0, bytesAfter },
          });
          continue;
        }

        const targetPath = await workspaces.resolveEntryPath(input.workspaceId, operation.path);
        const targetStats = await lstat(targetPath);
        if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
          throw new Error(`Patch target is not a regular file: ${normalizedPath}`);
        }
        const beforeContent = await readBoundedText(targetPath);
        const bytesBefore = Buffer.byteLength(beforeContent, "utf8");
        const beforeFingerprint = fingerprint(targetStats);

        if (operation.op === "edit_file") {
          if (operation.oldText.length === 0) throw new Error("Patch oldText must not be empty");
          const occurrences = beforeContent.split(operation.oldText).length - 1;
          if (occurrences !== 1) {
            throw new Error(`Patch oldText must occur exactly once in ${normalizedPath}; found ${occurrences}`);
          }
          const afterContent = beforeContent.replace(operation.oldText, operation.newText);
          const bytesAfter = Buffer.byteLength(afterContent, "utf8");
          if (bytesAfter > MAX_WRITE_BYTES) throw new Error(`Patched file exceeds 1 MiB: ${normalizedPath}`);
          totalNewBytes += bytesAfter;
          prepared.push({
            operation,
            targetPath,
            beforeContent,
            beforeFingerprint,
            afterContent,
            change: { op: operation.op, path: normalizedPath, bytesBefore, bytesAfter },
          });
          continue;
        }

        const actualSha256 = createHash("sha256").update(Buffer.from(beforeContent, "utf8")).digest("hex");
        if (actualSha256 !== operation.expectedSha256.toLocaleLowerCase("en-US")) {
          throw new Error(`Patch SHA-256 mismatch: ${normalizedPath}`);
        }
        prepared.push({
          operation,
          targetPath,
          beforeContent,
          beforeFingerprint,
          change: { op: operation.op, path: normalizedPath, bytesBefore, bytesAfter: 0 },
        });
      }

      if (totalNewBytes > MAX_PATCH_NEW_BYTES) {
        throw new Error("Patch new content exceeds the 5 MiB aggregate limit");
      }
      const changes = prepared.map((entry) => entry.change);
      if (input.dryRun === true) return { dryRun: true, applied: false, changes };

      const applied: PreparedPatchOperation[] = [];
      const appliedFingerprints = new Map<PreparedPatchOperation, EntryFingerprint>();
      try {
        for (const entry of prepared) {
          if (entry.operation.op === "create_file") {
            if (await pathExists(entry.targetPath)) {
              throw new Error(`Patch target changed before apply: ${entry.change.path}`);
            }
            await atomicReplace(
              workspaces,
              input.workspaceId,
              entry.operation.path,
              entry.afterContent ?? "",
              { noReplace: true },
            );
          } else {
            const currentStats = await lstat(entry.targetPath);
            const currentContent = await readBoundedText(entry.targetPath);
            if (entry.beforeFingerprint === undefined
              || !sameFingerprint(fingerprint(currentStats), entry.beforeFingerprint)
              || currentContent !== entry.beforeContent) {
              throw new Error(`Patch target changed before apply: ${entry.change.path}`);
            }
            if (entry.operation.op === "edit_file") {
              await atomicReplace(
                workspaces,
                input.workspaceId,
                entry.operation.path,
                entry.afterContent ?? "",
                { expectedContent: entry.beforeContent },
              );
            } else {
              await unlink(entry.targetPath);
            }
          }
          if (entry.operation.op !== "delete_file") {
            appliedFingerprints.set(entry, fingerprint(await lstat(entry.targetPath)));
          }
          applied.push(entry);
        }
      } catch (error) {
        const rollbackErrors: string[] = [];
        for (const entry of applied.reverse()) {
          try {
            if (entry.operation.op === "create_file") {
              const rollbackPath = await workspaces.resolveEntryPath(input.workspaceId, entry.operation.path);
              const rollbackStats = await lstat(rollbackPath);
              const appliedFingerprint = appliedFingerprints.get(entry);
              if (appliedFingerprint === undefined
                || !sameFingerprint(fingerprint(rollbackStats), appliedFingerprint)
                || await readBoundedText(rollbackPath) !== entry.afterContent) {
                throw new Error(`Patch rollback conflict: ${entry.change.path}`);
              }
              await unlink(rollbackPath);
            } else if (entry.operation.op === "edit_file") {
              const currentStats = await lstat(entry.targetPath);
              const appliedFingerprint = appliedFingerprints.get(entry);
              if (appliedFingerprint === undefined
                || !sameFingerprint(fingerprint(currentStats), appliedFingerprint)
                || await readBoundedText(entry.targetPath) !== entry.afterContent) {
                throw new Error(`Patch rollback conflict: ${entry.change.path}`);
              }
              await atomicReplace(
                workspaces,
                input.workspaceId,
                entry.operation.path,
                entry.beforeContent ?? "",
                { expectedContent: entry.afterContent },
              );
            } else {
              if (await pathExists(entry.targetPath)) {
                throw new Error(`Patch rollback conflict: ${entry.change.path}`);
              }
              await atomicReplace(
                workspaces,
                input.workspaceId,
                entry.operation.path,
                entry.beforeContent ?? "",
                { noReplace: true },
              );
            }
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : "rollback failed");
          }
        }
        const originalMessage = error instanceof Error ? error.message : "Patch failed";
        if (rollbackErrors.length > 0) {
          throw new Error(`${originalMessage}; rollback errors: ${rollbackErrors.join("; ")}`);
        }
        throw error;
      }
      return { dryRun: false, applied: true, changes };
      });
    },
  };
}
