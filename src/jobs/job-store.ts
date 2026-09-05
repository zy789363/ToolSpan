import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { JobRecord, JobStatus } from "./job-service.js";

interface JobRow {
  id: string;
  workspace_id: string;
  runner: string;
  args_json: string;
  status: JobStatus;
  pid: number | null;
  pid_start_token: string | null;
  exit_code: number | null;
  error: string | null;
  log_path: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface PrunableJobRow {
  id: string;
  log_path: string;
}

export interface RecoverableJobProcess {
  id: string;
  pid: number;
  pidStartToken: string;
}

function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runner: row.runner,
    args: JSON.parse(row.args_json) as string[],
    status: row.status,
    pid: row.pid,
    exitCode: row.exit_code,
    error: row.error,
    logPath: row.log_path,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export class JobStore {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      database.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          runner TEXT NOT NULL,
          args_json TEXT NOT NULL,
          status TEXT NOT NULL,
          pid INTEGER,
          pid_start_token TEXT,
          exit_code INTEGER,
          error TEXT,
          log_path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS jobs_workspace_idx ON jobs(workspace_id, created_at DESC);
      `);
      try {
        database.exec("ALTER TABLE jobs ADD COLUMN pid_start_token TEXT");
      } catch (error) {
        if (!String(error).toLowerCase().includes("duplicate column name")) throw error;
      }
    } catch (error) {
      try {
        database.close();
      } catch {
        // Preserve the initialization error; the handle has already been abandoned.
      }
      throw error;
    }
    this.#database = database;
  }

  insert(record: JobRecord, pidStartToken: string | null = null): void {
    this.#database
      .prepare(
        `INSERT INTO jobs
          (id, workspace_id, runner, args_json, status, pid, pid_start_token, exit_code, error, log_path,
           created_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId,
        record.runner,
        JSON.stringify(record.args),
        record.status,
        record.pid,
        pidStartToken,
        record.exitCode,
        record.error,
        record.logPath,
        record.createdAt,
        record.startedAt,
        record.finishedAt,
      );
  }

  finish(id: string, status: JobStatus, exitCode: number | null, error: string | null): void {
    this.#database
      .prepare(
        `UPDATE jobs SET status = ?, pid = NULL, pid_start_token = NULL,
         exit_code = ?, error = ?, finished_at = ? WHERE id = ?`,
      )
      .run(status, exitCode, error, new Date().toISOString(), id);
  }

  get(id: string): JobRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
      | JobRow
      | undefined;
    return row === undefined ? undefined : mapJob(row);
  }

  list(workspaceId?: string, status?: JobStatus): JobRecord[] {
    let sql = "SELECT * FROM jobs";
    const values: Array<string> = [];
    const clauses: string[] = [];
    if (workspaceId !== undefined) {
      clauses.push("workspace_id = ?");
      values.push(workspaceId);
    }
    if (status !== undefined) {
      clauses.push("status = ?");
      values.push(status);
    }
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += " ORDER BY created_at DESC";
    return (this.#database.prepare(sql).all(...values) as unknown as JobRow[]).map(mapJob);
  }

  interruptNonterminal(): void {
    this.#database
      .prepare(
        `UPDATE jobs SET status = 'interrupted', pid = NULL, pid_start_token = NULL,
         error = 'Service restarted', finished_at = ?
         WHERE status IN ('queued', 'running')`,
      )
      .run(new Date().toISOString());
  }

  listRecoverableProcesses(): RecoverableJobProcess[] {
    return this.#database
      .prepare(
        `SELECT id, pid, pid_start_token FROM jobs
         WHERE status IN ('queued', 'running')
           AND pid IS NOT NULL AND pid_start_token IS NOT NULL`,
      )
      .all()
      .map((row) => {
        const process = row as { id: string; pid: number; pid_start_token: string };
        return {
          id: process.id,
          pid: process.pid,
          pidStartToken: process.pid_start_token,
        };
      });
  }

  pruneTerminal(maxRetained: number, protectedJobIds: readonly string[] = []): string[] {
    if (!Number.isInteger(maxRetained) || maxRetained < 0) {
      throw new Error("maxRetained must be a non-negative integer");
    }
    const allRows = this.#database
      .prepare(
        `SELECT id, log_path FROM jobs
         WHERE status NOT IN ('queued', 'running')
         ORDER BY created_at DESC`,
      )
      .all() as unknown as PrunableJobRow[];
    const protectedIds = new Set(protectedJobIds);
    const rows = allRows.slice(maxRetained).filter((row) => !protectedIds.has(row.id));
    if (rows.length === 0) return [];

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const remove = this.#database.prepare("DELETE FROM jobs WHERE id = ?");
      for (const row of rows) remove.run(row.id);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return rows.map((row) => row.log_path);
  }

  close(): void {
    this.#database.close();
  }
}
