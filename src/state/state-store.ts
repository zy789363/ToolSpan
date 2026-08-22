import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type WorkspaceStatus = "active" | "history";

export interface WorkspaceRecord {
  id: string;
  path: string;
  status: WorkspaceStatus;
  openedAt: string;
  lastOpenedAt: string;
}

interface WorkspaceRow {
  id: string;
  path: string;
  status: WorkspaceStatus;
  opened_at: string;
  last_opened_at: string;
}

function mapWorkspace(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    path: row.path,
    status: row.status,
    openedAt: row.opened_at,
    lastOpenedAt: row.last_opened_at,
  };
}

export class StateStore {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('active', 'history')),
        opened_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      );
    `);
  }

  findWorkspaceByPath(canonicalPath: string): WorkspaceRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM workspaces WHERE path = ?")
      .get(canonicalPath) as WorkspaceRow | undefined;
    return row === undefined ? undefined : mapWorkspace(row);
  }

  findWorkspaceById(id: string): WorkspaceRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
      | WorkspaceRow
      | undefined;
    return row === undefined ? undefined : mapWorkspace(row);
  }

  insertWorkspace(record: WorkspaceRecord): void {
    this.#database
      .prepare(
        `INSERT INTO workspaces (id, path, status, opened_at, last_opened_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.path, record.status, record.openedAt, record.lastOpenedAt);
  }

  touchWorkspace(id: string, timestamp: string): WorkspaceRecord {
    this.#database
      .prepare("UPDATE workspaces SET status = 'active', last_opened_at = ? WHERE id = ?")
      .run(timestamp, id);
    const row = this.#database.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
      | WorkspaceRow
      | undefined;
    if (row === undefined) {
      throw new Error("Workspace not found");
    }
    return mapWorkspace(row);
  }

  listWorkspaces(status?: WorkspaceStatus): WorkspaceRecord[] {
    const rows = (
      status === undefined
        ? this.#database.prepare("SELECT * FROM workspaces ORDER BY last_opened_at DESC").all()
        : this.#database
            .prepare("SELECT * FROM workspaces WHERE status = ? ORDER BY last_opened_at DESC")
            .all(status)
    ) as unknown as WorkspaceRow[];
    return rows.map(mapWorkspace);
  }

  close(): void {
    this.#database.close();
  }
}
