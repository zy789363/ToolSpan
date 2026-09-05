import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";

const writeTails = new Map<string, Promise<void>>();

interface ConfigSnapshot {
  document: Record<string, unknown>;
  raw: string;
}

/** Reads only the public origin from the Core JSON config without creating runtime state. */
export async function readPublicBaseUrl(configPath: string): Promise<string> {
  const document = await readConfigDocument(configPath);
  return requireConfiguredOrigin(document.publicBaseUrl);
}

/**
 * Replaces publicBaseUrl through a same-directory temporary file and rename.
 * The input is an origin only; credentials, paths, queries, and fragments are rejected.
 */
export async function writePublicBaseUrlAtomically(configPath: string, origin: string): Promise<void> {
  const publicOrigin = requirePublicOrigin(origin);
  const absolutePath = path.resolve(configPath);
  return withWriteLock(absolutePath, async () => {
    const before = await readConfigSnapshot(absolutePath);
    before.document.publicBaseUrl = publicOrigin;
    const serialized = `${JSON.stringify(before.document, null, 2)}\n`;
    const temporaryPath = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const lockPath = `${absolutePath}.toolspan-write.lock`;
    const lockToken = `${process.pid}:${randomUUID()}`;
    let lockHandle;
    let lockOwned = false;
    try {
      try {
        lockHandle = await open(lockPath, "wx", 0o600);
        lockOwned = true;
        await lockHandle.writeFile(lockToken, "utf8");
        await lockHandle.sync();
      } catch (error) {
        await lockHandle?.close().catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error("Core config is being updated by another process", { cause: error });
        }
        throw error;
      }

      let temporaryHandle;
      try {
        temporaryHandle = await open(temporaryPath, "wx", 0o600);
        await temporaryHandle.writeFile(serialized, "utf8");
        await temporaryHandle.sync();
      } catch (error) {
        await temporaryHandle?.close().catch(() => undefined);
        await rm(temporaryPath, { force: true });
        throw error;
      }
      await temporaryHandle.close();

      // This is a best-effort CAS for writers that do not honor the sidecar lock:
      // refuse to replace the file if it changed after our initial read.
      const current = await readConfigSnapshot(absolutePath);
      if (current.raw !== before.raw) {
        await rm(temporaryPath, { force: true });
        throw new Error("Core config changed during publicBaseUrl update");
      }
      try {
        await rename(temporaryPath, absolutePath);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
      const persisted = await readConfigSnapshot(absolutePath);
      if (persisted.raw !== serialized || requireConfiguredOrigin(persisted.document.publicBaseUrl) !== publicOrigin) {
        throw new Error("Core publicBaseUrl write verification failed");
      }
    } finally {
      await lockHandle?.close().catch(() => undefined);
      if (lockOwned) {
        try {
          if ((await readFile(lockPath, "utf8")) === lockToken) await unlink(lockPath);
        } catch {
          // Preserve an externally changed lock so a competing writer fails safe.
        }
      }
      await rm(temporaryPath, { force: true });
    }
  });
}

async function readConfigDocument(configPath: string): Promise<Record<string, unknown>> {
  return (await readConfigSnapshot(configPath)).document;
}

async function readConfigSnapshot(configPath: string): Promise<ConfigSnapshot> {
  let raw: string;
  let parsed: unknown;
  try {
    raw = await readFile(path.resolve(configPath), "utf8");
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error("Core config could not be read as JSON", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Core config must be a JSON object");
  }
  return { document: parsed as Record<string, unknown>, raw };
}

async function withWriteLock<T>(configPath: string, operation: () => Promise<T>): Promise<T> {
  const predecessor = writeTails.get(configPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  writeTails.set(configPath, current);
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
    if (writeTails.get(configPath) === current) writeTails.delete(configPath);
  }
}

function requirePublicOrigin(value: unknown): string {
  return requireOrigin(value, false);
}

function requireConfiguredOrigin(value: unknown): string {
  return requireOrigin(value, true);
}

function requireOrigin(value: unknown, allowLocalHttp: boolean): string {
  if (typeof value !== "string") throw new Error("Core publicBaseUrl must be a URL origin");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error("Core publicBaseUrl must be a URL origin", { cause: error });
  }
  if (
    (!allowLocalHttp && parsed.protocol !== "https:")
    || (allowLocalHttp && parsed.protocol !== "https:" && !(
      parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    ))
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.origin !== value
  ) {
    throw new Error("Core publicBaseUrl must be an HTTPS origin without credentials or a path");
  }
  return parsed.origin;
}
