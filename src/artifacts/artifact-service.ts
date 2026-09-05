import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import type { JobService } from "../jobs/job-service.js";
import type { WorkspaceService } from "../workspaces/workspace-service.js";
import { ArtifactStore } from "./artifact-store.js";

export type ArtifactProfile = "workspace_snapshot" | "git_diff" | "job_output";

export interface ArtifactRecord {
  id: string;
  workspaceId: string;
  profile: ArtifactProfile;
  jobId: string | null;
  filePath: string;
  mediaType: string;
  size: number;
  sha256: string;
  createdAt: string;
  publishedSlug: string | null;
}

export interface ArtifactServiceOptions {
  workspaces: WorkspaceService;
  jobs?: JobService;
  databasePath: string;
  artifactsDirectory: string;
  publicBaseUrl: string;
  previewSecret: Buffer;
}

export interface ArtifactService {
  startCapture(input: {
    workspaceId: string;
    profile: ArtifactProfile;
    jobId?: string;
  }): Promise<ArtifactRecord>;
  inspectArtifact(id: string): Promise<{ artifact: ArtifactRecord; preview: string }>;
  listArtifacts(workspaceId?: string): Promise<ArtifactRecord[]>;
  previewArtifact(id: string, ttlSeconds?: number): Promise<{ url: string; expiresAt: string }>;
  publishArtifact(id: string): Promise<{ url: string }>;
  resolvePreview(token: string): Promise<ArtifactRecord>;
  resolvePublished(slug: string): Promise<ArtifactRecord>;
  close(): void;
}

interface SnapshotEntry {
  path: string;
  size: number;
  modifiedAt: string;
}

async function readStableFileMetadata(
  entryPath: string,
  canonicalPath: string,
): Promise<SnapshotEntry | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(entryPath);
    if (!before.isFile()) return undefined;
    const beforeCanonical = await realpath(entryPath);
    if (comparisonPath(beforeCanonical) !== comparisonPath(canonicalPath)) return undefined;
    handle = await open(canonicalPath, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) return undefined;
    const afterCanonical = await realpath(entryPath);
    if (comparisonPath(afterCanonical) !== comparisonPath(canonicalPath)) return undefined;
    return {
      path: "",
      size: metadata.size,
      modifiedAt: metadata.mtime.toISOString(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
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

async function createWorkspaceSnapshot(root: string): Promise<Buffer> {
  const entries: SnapshotEntry[] = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      if (entries.length >= 5000) throw new Error("Workspace snapshot exceeds 5000 files");
      if (child.name === ".git" || child.name === ".webgpt") continue;
      const relativePath = path.join(relativeDirectory, child.name);
      const absolutePath = path.join(directory, child.name);
      const childStats = await lstat(absolutePath);
      if (childStats.isSymbolicLink()) continue;
      let canonicalPath: string;
      try {
        canonicalPath = await realpath(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!isWithin(canonicalPath, root)) continue;
      if (comparisonPath(canonicalPath) !== comparisonPath(absolutePath)) continue;
      if (childStats.isDirectory()) {
        await visit(canonicalPath, relativePath);
      } else if (childStats.isFile()) {
        const metadata = await readStableFileMetadata(absolutePath, canonicalPath);
        if (metadata !== undefined) {
          entries.push({ ...metadata, path: relativePath.replaceAll("\\", "/") });
        }
      }
    }
  };
  await visit(root, "");
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return Buffer.from(`${JSON.stringify({ files: entries }, null, 2)}\n`, "utf8");
}

async function createGitDiff(root: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"],
      { cwd: root, encoding: "buffer", maxBuffer: 10 * 1024 * 1024, timeout: 30_000, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error(`Git diff failed: ${error.message}`));
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

function createPreviewHash(secret: Buffer, token: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}

function publicUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/$/, "")}${pathname}`;
}

export async function createArtifactService(
  options: ArtifactServiceOptions,
): Promise<ArtifactService> {
  await mkdir(options.artifactsDirectory, { recursive: true });
  const store = new ArtifactStore(options.databasePath);

  return {
    async startCapture(input): Promise<ArtifactRecord> {
      const root = await options.workspaces.resolveWorkspaceRoot(input.workspaceId);
      let content: Buffer;
      let fileName: string;
      let mediaType: string;
      if (input.profile === "workspace_snapshot") {
        content = await createWorkspaceSnapshot(root);
        fileName = "workspace-snapshot.json";
        mediaType = "application/json";
      } else if (input.profile === "git_diff") {
        content = await createGitDiff(root);
        fileName = "git.diff";
        mediaType = "text/x-diff";
      } else {
        if (input.jobId === undefined) throw new Error("jobId is required for job_output");
        if (options.jobs === undefined) throw new Error("Job service is not configured");
        const output = await options.jobs.readJobOutput(input.jobId);
        if (output.job.workspaceId !== input.workspaceId) {
          throw new Error("Job does not belong to workspace");
        }
        content = output.content;
        fileName = "job-output.txt";
        mediaType = "text/plain; charset=utf-8";
      }
      const id = randomUUID();
      const directory = path.join(options.artifactsDirectory, id);
      await mkdir(directory);
      const filePath = path.join(directory, fileName);
      await writeFile(filePath, content, { flag: "wx" });
      const record: ArtifactRecord = {
        id,
        workspaceId: input.workspaceId,
        profile: input.profile,
        jobId: input.jobId ?? null,
        filePath,
        mediaType,
        size: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
        createdAt: new Date().toISOString(),
        publishedSlug: null,
      };
      store.insert(record);
      return record;
    },

    async inspectArtifact(id): Promise<{ artifact: ArtifactRecord; preview: string }> {
      const artifact = store.get(id);
      if (artifact === undefined) throw new Error("Artifact not found");
      const content = await readFile(artifact.filePath);
      return { artifact, preview: content.subarray(0, 64 * 1024).toString("utf8") };
    },

    async listArtifacts(workspaceId): Promise<ArtifactRecord[]> {
      return store.list(workspaceId);
    },

    async previewArtifact(id, ttlSeconds = 300): Promise<{ url: string; expiresAt: string }> {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) {
        throw new Error("ttlSeconds must be an integer between 60 and 3600");
      }
      if (store.get(id) === undefined) throw new Error("Artifact not found");
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
      store.createPreview(id, createPreviewHash(options.previewSecret, token), expiresAt);
      return {
        url: publicUrl(options.publicBaseUrl, `/artifacts/preview/${token}`),
        expiresAt,
      };
    },

    async publishArtifact(id): Promise<{ url: string }> {
      const existing = store.get(id);
      if (existing === undefined) throw new Error("Artifact not found");
      const artifact = existing.publishedSlug === null
        ? store.publish(id, randomBytes(18).toString("base64url"))
        : existing;
      if (artifact?.publishedSlug === null || artifact === undefined) {
        throw new Error("Artifact could not be published");
      }
      return { url: publicUrl(options.publicBaseUrl, `/artifacts/published/${artifact.publishedSlug}`) };
    },

    async resolvePreview(token): Promise<ArtifactRecord> {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Preview not found");
      const artifact = store.resolvePreview(
        createPreviewHash(options.previewSecret, token),
        new Date().toISOString(),
      );
      if (artifact === undefined) throw new Error("Preview not found");
      return artifact;
    },

    async resolvePublished(slug): Promise<ArtifactRecord> {
      if (!/^[A-Za-z0-9_-]{24}$/.test(slug)) throw new Error("Published artifact not found");
      const artifact = store.resolvePublished(slug);
      if (artifact === undefined) throw new Error("Published artifact not found");
      return artifact;
    },

    close(): void {
      store.close();
    },
  };
}
