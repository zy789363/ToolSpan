import { randomUUID } from "node:crypto";

import { createPathGuard, type PathGuard } from "../security/path-guard.js";
import {
  StateStore,
  type WorkspaceRecord,
  type WorkspaceStatus,
} from "../state/state-store.js";

export interface WorkspaceServiceOptions {
  allowedRoots: readonly string[];
  databasePath: string;
}

export interface WorkspaceService {
  openWorkspace(candidatePath: string): Promise<WorkspaceRecord>;
  listWorkspaces(status?: WorkspaceStatus): Promise<WorkspaceRecord[]>;
  resumeWorkspace(id: string): Promise<WorkspaceRecord>;
  resolveExistingPath(id: string, relativePath: string): Promise<string>;
  resolveEntryPath(id: string, relativePath: string): Promise<string>;
  resolvePathForWrite(id: string, relativePath: string): Promise<string>;
  resolvePathForCreate(id: string, relativePath: string): Promise<string>;
  resolveWorkspaceRoot(id: string): Promise<string>;
  close(): void;
}

class DefaultWorkspaceService implements WorkspaceService {
  readonly #guard: PathGuard;
  readonly #store: StateStore;

  constructor(guard: PathGuard, store: StateStore) {
    this.#guard = guard;
    this.#store = store;
  }

  async openWorkspace(candidatePath: string): Promise<WorkspaceRecord> {
    const canonicalPath = await this.#guard.openWorkspace(candidatePath);
    const timestamp = new Date().toISOString();
    const existing = this.#store.findWorkspaceByPath(canonicalPath);
    if (existing !== undefined) {
      return this.#store.touchWorkspace(existing.id, timestamp);
    }

    const workspace: WorkspaceRecord = {
      id: randomUUID(),
      path: canonicalPath,
      status: "active",
      openedAt: timestamp,
      lastOpenedAt: timestamp,
    };
    this.#store.insertWorkspace(workspace);
    return workspace;
  }

  async listWorkspaces(status?: WorkspaceStatus): Promise<WorkspaceRecord[]> {
    return this.#store.listWorkspaces(status);
  }

  async resumeWorkspace(id: string): Promise<WorkspaceRecord> {
    const workspace = this.#store.findWorkspaceById(id);
    if (workspace === undefined) {
      throw new Error("Workspace not found");
    }
    await this.#guard.openWorkspace(workspace.path);
    return this.#store.touchWorkspace(id, new Date().toISOString());
  }

  async resolveExistingPath(id: string, relativePath: string): Promise<string> {
    const workspace = this.#store.findWorkspaceById(id);
    if (workspace === undefined) {
      throw new Error("Workspace not found");
    }
    const root = await this.#guard.openWorkspace(workspace.path);
    return this.#guard.resolveExisting(root, relativePath);
  }

  async resolveEntryPath(id: string, relativePath: string): Promise<string> {
    const workspace = this.#store.findWorkspaceById(id);
    if (workspace === undefined) {
      throw new Error("Workspace not found");
    }
    const root = await this.#guard.openWorkspace(workspace.path);
    return this.#guard.resolveEntry(root, relativePath);
  }

  async resolvePathForWrite(id: string, relativePath: string): Promise<string> {
    const workspace = this.#store.findWorkspaceById(id);
    if (workspace === undefined) {
      throw new Error("Workspace not found");
    }
    const root = await this.#guard.openWorkspace(workspace.path);
    return this.#guard.resolveForWrite(root, relativePath);
  }

  async resolvePathForCreate(id: string, relativePath: string): Promise<string> {
    const workspace = this.#store.findWorkspaceById(id);
    if (workspace === undefined) {
      throw new Error("Workspace not found");
    }
    const root = await this.#guard.openWorkspace(workspace.path);
    return this.#guard.resolveForCreate(root, relativePath);
  }

  async resolveWorkspaceRoot(id: string): Promise<string> {
    const workspace = this.#store.findWorkspaceById(id);
    if (workspace === undefined) {
      throw new Error("Workspace not found");
    }
    return this.#guard.openWorkspace(workspace.path);
  }

  close(): void {
    this.#store.close();
  }
}

export async function createWorkspaceService(
  options: WorkspaceServiceOptions,
): Promise<WorkspaceService> {
  const guard = await createPathGuard(options.allowedRoots);
  return new DefaultWorkspaceService(guard, new StateStore(options.databasePath));
}
