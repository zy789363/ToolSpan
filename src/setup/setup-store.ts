import { mkdir, open, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertPersistable } from "./redaction.js";
import {
  SETUP_JOURNAL_VERSION,
  SETUP_PROTOCOL_VERSION,
  SETUP_STATE_SCHEMA_VERSION,
  type SetupJournal,
  type SetupJournalEntry,
  type SetupLock,
  type SetupManifest,
  type SetupReceipt,
  type SetupSessionRecord,
  type SetupStateDocument,
} from "./types.js";

export interface ProcessInspector {
  isAlive(pid: number): boolean;
}

export const operatingSystemProcessInspector: ProcessInspector = {
  isAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
};

export class SetupStore {
  readonly #directory: string;
  readonly #statePath: string;
  readonly #lockPath: string;

  constructor(directory: string) {
    this.#directory = path.resolve(directory);
    this.#statePath = path.join(this.#directory, "setup-state.json");
    this.#lockPath = path.join(this.#directory, "setup.lock");
  }

  async initialize(now: string): Promise<void> {
    await Promise.all([
      mkdir(path.join(this.#directory, "manifests"), { recursive: true }),
      mkdir(path.join(this.#directory, "journals"), { recursive: true }),
      mkdir(path.join(this.#directory, "receipts"), { recursive: true }),
    ]);
    const existing = await this.readJson<SetupStateDocument>(this.#statePath);
    if (existing === undefined) {
      await this.writeState({
        schemaVersion: SETUP_STATE_SCHEMA_VERSION,
        setupProtocolVersion: SETUP_PROTOCOL_VERSION,
        updatedAt: now,
        sessions: {},
      });
    }
  }

  async readState(): Promise<SetupStateDocument> {
    const state = await this.readJson<SetupStateDocument>(this.#statePath);
    if (state === undefined) throw new Error("Setup state store is not initialized");
    return state;
  }

  async writeState(state: SetupStateDocument, secrets: readonly string[] = []): Promise<void> {
    await this.atomicWrite(this.#statePath, state, secrets);
  }

  async readSession(sessionId: string): Promise<SetupSessionRecord | undefined> {
    return (await this.readState()).sessions[sessionId];
  }

  async writeSession(record: SetupSessionRecord, secrets: readonly string[] = []): Promise<void> {
    const state = await this.readState();
    state.sessions[record.sessionId] = record;
    state.currentSessionId = record.sessionId;
    state.updatedAt = record.updatedAt;
    await this.writeState(state, secrets);
  }

  async writeManifest(sessionId: string, manifest: SetupManifest, secrets: readonly string[] = []): Promise<void> {
    await this.atomicWrite(this.manifestPath(sessionId), manifest, secrets);
  }

  async readManifest(sessionId: string): Promise<SetupManifest | undefined> {
    return this.readJson<SetupManifest>(this.manifestPath(sessionId));
  }

  async readJournal(sessionId: string): Promise<SetupJournal | undefined> {
    return this.readJson<SetupJournal>(this.journalPath(sessionId));
  }

  async createJournal(sessionId: string, idempotencyKey: string, secrets: readonly string[] = []): Promise<void> {
    await this.atomicWrite(
      this.journalPath(sessionId),
      { schemaVersion: SETUP_JOURNAL_VERSION, sessionId, idempotencyKey, entries: [] } satisfies SetupJournal,
      secrets,
    );
  }

  async appendJournal(sessionId: string, entry: Omit<SetupJournalEntry, "sequence">, secrets: readonly string[] = []): Promise<void> {
    const journal = await this.readJournal(sessionId);
    if (journal === undefined) throw new Error(`Setup journal not found: ${sessionId}`);
    journal.entries.push({ ...entry, sequence: journal.entries.length + 1 });
    await this.atomicWrite(this.journalPath(sessionId), journal, secrets);
  }

  async writeReceipt(receipt: SetupReceipt, secrets: readonly string[] = []): Promise<void> {
    await this.atomicWrite(this.receiptPath(receipt.sessionId), receipt, secrets);
  }

  async readReceipt(sessionId: string): Promise<SetupReceipt | undefined> {
    return this.readJson<SetupReceipt>(this.receiptPath(sessionId));
  }

  async listReceipts(): Promise<SetupReceipt[]> {
    const directory = path.join(this.#directory, "receipts");
    const entries = await readdir(directory, { withFileTypes: true });
    const receipts = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => this.readJson<SetupReceipt>(path.join(directory, entry.name))),
    );
    return receipts.filter((receipt): receipt is SetupReceipt => receipt !== undefined);
  }

  async readLock(): Promise<SetupLock | undefined> {
    return this.readJson<SetupLock>(this.#lockPath);
  }

  async acquireLock(lock: SetupLock): Promise<void> {
    assertPersistable(lock);
    await mkdir(this.#directory, { recursive: true });
    let handle;
    try {
      handle = await open(this.#lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Another setup mutation session is active");
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async releaseLock(sessionId: string): Promise<void> {
    const lock = await this.readLock();
    if (lock === undefined) return;
    if (lock.sessionId !== sessionId) throw new Error("Cannot release another setup session lock");
    await unlink(this.#lockPath);
  }

  async removeVerifiedStaleLock(inspector: ProcessInspector): Promise<SetupLock | undefined> {
    const lock = await this.readLock();
    if (lock === undefined) return undefined;
    if (inspector.isAlive(lock.pid)) return undefined;
    await unlink(this.#lockPath);
    return lock;
  }

  private manifestPath(sessionId: string): string {
    return path.join(this.#directory, "manifests", `${safeId(sessionId)}.json`);
  }

  private journalPath(sessionId: string): string {
    return path.join(this.#directory, "journals", `${safeId(sessionId)}.json`);
  }

  private receiptPath(sessionId: string): string {
    return path.join(this.#directory, "receipts", `${safeId(sessionId)}.json`);
  }

  private async atomicWrite(filePath: string, value: unknown, secrets: readonly string[] = []): Promise<void> {
    assertPersistable(value, secrets);
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      await rename(temporaryPath, filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private async readJson<T>(filePath: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

function safeId(sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(sessionId)) throw new Error("Invalid setup session ID");
  return sessionId;
}
