import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
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
  change: PatchChangeResult;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
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
): Promise<void> {
  const targetPath = await workspaces.resolvePathForWrite(workspaceId, relativePath);
  const temporaryPath = path.join(path.dirname(targetPath), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    const verifiedTarget = await workspaces.resolvePathForWrite(workspaceId, relativePath);
    if (comparisonPath(verifiedTarget) !== comparisonPath(targetPath)) {
      throw new Error("Path changed during write");
    }
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
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
  try {
    await writeFile(temporaryPath, content, { flag: "wx" });
    const verifiedTarget = await workspaces.resolvePathForWrite(workspaceId, relativePath);
    if (comparisonPath(verifiedTarget) !== comparisonPath(targetPath)) {
      throw new Error("Path changed during write");
    }
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readBoundedText(targetPath: string): Promise<string> {
  const fileStats = await lstat(targetPath);
  if (!fileStats.isFile()) throw new Error("Path is not a regular file");
  if (fileStats.size > MAX_READ_BYTES) throw new Error("File exceeds the 1 MiB read limit");
  const content = await readFile(targetPath, "utf8");
  if (content.includes("\0")) throw new Error("Binary files are not supported");
  return content;
}

async function hashFile(targetPath: string, maximumBytes: number): Promise<string> {
  const fileStats = await lstat(targetPath);
  if (!fileStats.isFile()) throw new Error("SHA-256 is only available for regular files");
  if (fileStats.size > maximumBytes) {
    throw new Error(`File exceeds the ${String(maximumBytes)} byte hash limit`);
  }
  return createHash("sha256").update(await readFile(targetPath)).digest("hex");
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
    const children = await readdir(currentPath);
    children.sort((left, right) => left.localeCompare(right, "en"));
    for (const child of children) await visit(path.join(currentPath, child));
  };

  await visit(targetPath);
  return { entries, bytes };
}

async function copyEntry(
  sourcePath: string,
  destinationPath: string,
  workspaceRoot?: string,
  validateLinkTargets = false,
): Promise<void> {
  const sourceStats = await lstat(sourcePath);
  if (sourceStats.isFile()) {
    await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
    return;
  }
  if (sourceStats.isSymbolicLink()) {
    if (validateLinkTargets && workspaceRoot !== undefined) {
      const canonicalTarget = await realpath(sourcePath);
      if (!isWithin(canonicalTarget, workspaceRoot)) {
        throw new Error("Symbolic link target escapes workspace");
      }
    }
    await symlink(
      await readlink(sourcePath),
      destinationPath,
      process.platform === "win32" ? "junction" : undefined,
    );
    return;
  }
  if (!sourceStats.isDirectory()) throw new Error("Unsupported filesystem entry type");

  await mkdir(destinationPath);
  const children = await readdir(sourcePath);
  children.sort((left, right) => left.localeCompare(right, "en"));
  for (const child of children) {
    await copyEntry(
      path.join(sourcePath, child),
      path.join(destinationPath, child),
      workspaceRoot,
      validateLinkTargets,
    );
  }
}

async function removeEntry(targetPath: string, recursive: boolean): Promise<void> {
  const targetStats = await lstat(targetPath);
  if (targetStats.isDirectory() && !targetStats.isSymbolicLink()) {
    if (recursive) await rm(targetPath, { recursive: true });
    else await rmdir(targetPath);
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
    const fileStats = await stat(canonicalPath);
    if (!fileStats.isFile()) throw new Error("Path is not a file");
    if (fileStats.size > MAX_READ_BYTES) throw new Error("File exceeds the 1 MiB read limit");

    const content = await readFile(canonicalPath, "utf8");
    if (content.includes("\0")) throw new Error("Binary files are not supported");
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
      await atomicReplace(workspaces, input.workspaceId, input.path, input.content);
      return { path: normalizeToolPath(input.path), bytesWritten };
    },

    async edit(input: EditFileInput): Promise<EditFileResult> {
      if (input.oldText.length === 0) throw new Error("oldText must not be empty");
      const existingPath = await workspaces.resolveExistingPath(input.workspaceId, input.path);
      const content = await readFile(existingPath, "utf8");
      const occurrences = content.split(input.oldText).length - 1;
      if (occurrences !== 1) {
        throw new Error(`oldText must occur exactly once; found ${occurrences}`);
      }
      const updatedContent = content.replace(input.oldText, input.newText);
      if (Buffer.byteLength(updatedContent, "utf8") > MAX_WRITE_BYTES) {
        throw new Error("Edited content exceeds the 1 MiB write limit");
      }
      await atomicReplace(workspaces, input.workspaceId, input.path, updatedContent);
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
      arguments_.push(input.pattern, ".");
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
      await atomicReplaceBytes(workspaces, input.workspaceId, input.path, bytes);
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
      const targetPath = await workspaces.resolvePathForCreate(input.workspaceId, input.path);
      const workspaceRoot = await workspaces.resolveWorkspaceRoot(input.workspaceId);
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

      await mkdir(targetPath, { recursive: input.recursive ?? true });
      await workspaces.resolveExistingPath(input.workspaceId, input.path);
      return { path: normalizeToolPath(input.path), created: true };
    },

    async movePath(input: TransferPathInput): Promise<TransferPathResult> {
      const workspaceRoot = await workspaces.resolveWorkspaceRoot(input.workspaceId);
      const sourcePath = await workspaces.resolveEntryPath(input.workspaceId, input.source);
      const destinationPath = await workspaces.resolvePathForWrite(input.workspaceId, input.destination);
      assertNotWorkspaceRoot(workspaceRoot, sourcePath);
      assertNotWorkspaceRoot(workspaceRoot, destinationPath);
      if (await pathExists(destinationPath)) throw new Error("Destination already exists");
      const sourceStats = await lstat(sourcePath);
      if (sourceStats.isDirectory() && !sourceStats.isSymbolicLink()) {
        assertDirectoryDestination(sourcePath, destinationPath);
      }
      const metrics = sourceStats.isFile()
        ? { entries: 1, bytes: sourceStats.size }
        : sourceStats.isSymbolicLink()
          ? { entries: 1, bytes: 0 }
          : {};

      const verifiedSource = await workspaces.resolveEntryPath(input.workspaceId, input.source);
      const verifiedDestination = await workspaces.resolvePathForWrite(input.workspaceId, input.destination);
      if (
        comparisonPath(verifiedSource) !== comparisonPath(sourcePath)
        || comparisonPath(verifiedDestination) !== comparisonPath(destinationPath)
      ) {
        throw new Error("Path changed during move");
      }
      if (await pathExists(destinationPath)) throw new Error("Destination already exists");
      await rename(sourcePath, destinationPath);
      return {
        source: normalizeToolPath(input.source),
        destination: normalizeToolPath(input.destination),
        type: fileSystemType(sourceStats),
        ...metrics,
      };
    },

    async copyPath(input: TransferPathInput): Promise<TransferPathResult> {
      const workspaceRoot = await workspaces.resolveWorkspaceRoot(input.workspaceId);
      const sourcePath = await workspaces.resolveEntryPath(input.workspaceId, input.source);
      const destinationPath = await workspaces.resolvePathForWrite(input.workspaceId, input.destination);
      assertNotWorkspaceRoot(workspaceRoot, sourcePath);
      assertNotWorkspaceRoot(workspaceRoot, destinationPath);
      if (await pathExists(destinationPath)) throw new Error("Destination already exists");
      const sourceStats = await lstat(sourcePath);
      if (sourceStats.isDirectory() && !sourceStats.isSymbolicLink()) {
        assertDirectoryDestination(sourcePath, destinationPath);
      }
      const metrics = await scanTree(sourcePath, workspaceRoot, true);
      try {
        await copyEntry(sourcePath, destinationPath, workspaceRoot, true);
      } catch (error) {
        await rm(destinationPath, { recursive: true, force: true });
        throw error;
      }
      return {
        source: normalizeToolPath(input.source),
        destination: normalizeToolPath(input.destination),
        type: fileSystemType(sourceStats),
        ...metrics,
      };
    },

    async deletePath(input: DeletePathInput): Promise<DeletePathResult> {
      assertUuid(input.workspaceId, "workspaceId");
      const workspaceRoot = await workspaces.resolveWorkspaceRoot(input.workspaceId);
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
      const deletedAt = new Date().toISOString();
      if (input.permanent === true) {
        await removeEntry(sourcePath, recursive);
        return {
          path: normalizeToolPath(input.path),
          type: sourceType,
          permanent: true,
          deletedAt,
          ...(sourceStats.isFile()
            ? { entries: 1, bytes: sourceStats.size }
            : sourceStats.isSymbolicLink()
              ? { entries: 1, bytes: 0 }
              : {}),
        };
      }

      const metrics = await scanTree(sourcePath);
      const recoveryId = randomUUID();
      const workspaceRecoveryDirectory = path.join(recoveryDirectory, input.workspaceId);
      const finalRecoveryPath = path.join(workspaceRecoveryDirectory, recoveryId);
      const stagedRecoveryPath = path.join(workspaceRecoveryDirectory, `.${recoveryId}.${randomUUID()}.tmp`);
      const payloadPath = path.join(stagedRecoveryPath, "payload");
      await mkdir(workspaceRecoveryDirectory, { recursive: true });
      try {
        await mkdir(stagedRecoveryPath);
        await copyEntry(sourcePath, payloadPath);
        const copiedMetrics = await scanTree(payloadPath);
        if (copiedMetrics.entries !== metrics.entries || copiedMetrics.bytes !== metrics.bytes) {
          throw new Error("Recovery copy verification failed");
        }
        const manifest: RecoveryManifest = {
          version: 1,
          recoveryId,
          workspaceId: input.workspaceId,
          originalPath: normalizeToolPath(input.path),
          type: sourceType,
          deletedAt,
          ...metrics,
        };
        await writeFile(
          path.join(stagedRecoveryPath, "manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
          { encoding: "utf8", flag: "wx" },
        );
        await rename(stagedRecoveryPath, finalRecoveryPath);

        const verifiedSource = await workspaces.resolveEntryPath(input.workspaceId, input.path);
        if (comparisonPath(verifiedSource) !== comparisonPath(sourcePath)) {
          throw new Error("Path changed during delete");
        }
        const localStagingPath = path.join(path.dirname(sourcePath), `.${randomUUID()}.webgpt-delete`);
        try {
          await rename(sourcePath, localStagingPath);
        } catch (error) {
          await rm(finalRecoveryPath, { recursive: true, force: true });
          throw error;
        }
        await removeEntry(localStagingPath, true);
      } catch (error) {
        await rm(stagedRecoveryPath, { recursive: true, force: true });
        throw error;
      }

      return {
        path: normalizeToolPath(input.path),
        type: sourceType,
        permanent: false,
        deletedAt,
        recoveryId,
        ...metrics,
      };
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
      const workspaceRoot = await workspaces.resolveWorkspaceRoot(input.workspaceId);
      const destinationPath = await workspaces.resolvePathForWrite(input.workspaceId, destination);
      assertNotWorkspaceRoot(workspaceRoot, destinationPath);
      if (await pathExists(destinationPath)) throw new Error("Restore destination already exists");

      const payloadPath = path.join(recoveryPath, "payload");
      const metrics = await scanTree(payloadPath);
      if (metrics.entries !== manifest.entries || metrics.bytes !== manifest.bytes) {
        throw new Error("Recovery payload verification failed");
      }
      const stagedDestination = path.join(path.dirname(destinationPath), `.${randomUUID()}.webgpt-restore`);
      try {
        await copyEntry(payloadPath, stagedDestination);
        if (await pathExists(destinationPath)) throw new Error("Restore destination already exists");
        await rename(stagedDestination, destinationPath);
      } catch (error) {
        await rm(stagedDestination, { recursive: true, force: true });
        throw error;
      }
      await rm(recoveryPath, { recursive: true });
      return {
        recoveryId: input.recoveryId,
        originalPath: manifest.originalPath,
        restoredPath: normalizeToolPath(destination),
        type: manifest.type,
        ...metrics,
      };
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
      if (input.operations.length < 1 || input.operations.length > MAX_PATCH_OPERATIONS) {
        throw new Error(`operations must contain between 1 and ${MAX_PATCH_OPERATIONS} items`);
      }
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
          change: { op: operation.op, path: normalizedPath, bytesBefore, bytesAfter: 0 },
        });
      }

      if (totalNewBytes > MAX_PATCH_NEW_BYTES) {
        throw new Error("Patch new content exceeds the 5 MiB aggregate limit");
      }
      const changes = prepared.map((entry) => entry.change);
      if (input.dryRun === true) return { dryRun: true, applied: false, changes };

      const applied: PreparedPatchOperation[] = [];
      try {
        for (const entry of prepared) {
          if (entry.operation.op === "create_file") {
            if (await pathExists(entry.targetPath)) {
              throw new Error(`Patch target changed before apply: ${entry.change.path}`);
            }
            await atomicReplace(workspaces, input.workspaceId, entry.operation.path, entry.afterContent ?? "");
          } else {
            const currentContent = await readBoundedText(entry.targetPath);
            if (currentContent !== entry.beforeContent) {
              throw new Error(`Patch target changed before apply: ${entry.change.path}`);
            }
            if (entry.operation.op === "edit_file") {
              await atomicReplace(workspaces, input.workspaceId, entry.operation.path, entry.afterContent ?? "");
            } else {
              await unlink(entry.targetPath);
            }
          }
          applied.push(entry);
        }
      } catch (error) {
        const rollbackErrors: string[] = [];
        for (const entry of applied.reverse()) {
          try {
            if (entry.operation.op === "create_file") {
              const rollbackPath = await workspaces.resolveEntryPath(input.workspaceId, entry.operation.path);
              await unlink(rollbackPath);
            } else {
              await atomicReplace(
                workspaces,
                input.workspaceId,
                entry.operation.path,
                entry.beforeContent ?? "",
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
    },
  };
}
