import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ArtifactProfile, ArtifactRecord } from "./artifact-service.js";

interface ArtifactRow {
  id: string;
  workspace_id: string;
  profile: ArtifactProfile;
  job_id: string | null;
  file_path: string;
  media_type: string;
  size: number;
  sha256: string;
  created_at: string;
  published_slug: string | null;
}

function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    profile: row.profile,
    jobId: row.job_id,
    filePath: row.file_path,
    mediaType: row.media_type,
    size: row.size,
    sha256: row.sha256,
    createdAt: row.created_at,
    publishedSlug: row.published_slug,
  };
}

export class ArtifactStore {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        profile TEXT NOT NULL,
        job_id TEXT,
        file_path TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        published_slug TEXT UNIQUE
      );
      CREATE INDEX IF NOT EXISTS artifacts_workspace_idx
        ON artifacts(workspace_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS artifact_previews (
        token_hash TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artifact_previews_expiry_idx
        ON artifact_previews(expires_at);
    `);
  }

  insert(record: ArtifactRecord): void {
    this.#database
      .prepare(
        `INSERT INTO artifacts
          (id, workspace_id, profile, job_id, file_path, media_type, size, sha256,
           created_at, published_slug)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId,
        record.profile,
        record.jobId,
        record.filePath,
        record.mediaType,
        record.size,
        record.sha256,
        record.createdAt,
        record.publishedSlug,
      );
  }

  get(id: string): ArtifactRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as
      | ArtifactRow
      | undefined;
    return row === undefined ? undefined : mapArtifact(row);
  }

  list(workspaceId?: string): ArtifactRecord[] {
    const rows = (workspaceId === undefined
      ? this.#database.prepare("SELECT * FROM artifacts ORDER BY created_at DESC").all()
      : this.#database
          .prepare("SELECT * FROM artifacts WHERE workspace_id = ? ORDER BY created_at DESC")
          .all(workspaceId)) as unknown as ArtifactRow[];
    return rows.map(mapArtifact);
  }

  createPreview(artifactId: string, tokenHash: string, expiresAt: string): void {
    this.#database
      .prepare(
        `INSERT INTO artifact_previews (token_hash, artifact_id, expires_at, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(tokenHash, artifactId, expiresAt, new Date().toISOString());
  }

  resolvePreview(tokenHash: string, now: string): ArtifactRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT artifacts.* FROM artifact_previews
         JOIN artifacts ON artifacts.id = artifact_previews.artifact_id
         WHERE artifact_previews.token_hash = ? AND artifact_previews.expires_at > ?`,
      )
      .get(tokenHash, now) as ArtifactRow | undefined;
    return row === undefined ? undefined : mapArtifact(row);
  }

  publish(id: string, slug: string): ArtifactRecord | undefined {
    this.#database
      .prepare("UPDATE artifacts SET published_slug = COALESCE(published_slug, ?) WHERE id = ?")
      .run(slug, id);
    return this.get(id);
  }

  resolvePublished(slug: string): ArtifactRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM artifacts WHERE published_slug = ?")
      .get(slug) as ArtifactRow | undefined;
    return row === undefined ? undefined : mapArtifact(row);
  }

  close(): void {
    this.#database.close();
  }
}
