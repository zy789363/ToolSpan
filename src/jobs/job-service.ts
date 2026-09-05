import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceService } from "../workspaces/workspace-service.js";
import { JobStore, type RecoverableJobProcess } from "./job-store.js";

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export interface JobRecord {
  id: string;
  workspaceId: string;
  runner: string;
  args: string[];
  status: JobStatus;
  pid: number | null;
  exitCode: number | null;
  error: string | null;
  logPath: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunnerDefinition {
  executable: string;
  prefixArgs?: readonly string[];
  validateArgs(args: readonly string[]): boolean;
  resolveCommand?(
    args: readonly string[],
    cwd: string,
  ): Promise<{ executable: string; args: string[] }> | { executable: string; args: string[] };
  maxConcurrent: number;
  maxConcurrentPerWorkspace?: number;
  maxTimeoutSeconds: number;
  maxOutputBytes: number;
  environment?: Readonly<Record<string, string>>;
  inheritEnvironment?: boolean;
  requiredFiles?: readonly string[];
  availabilityCheck?: () => Promise<boolean> | boolean;
}

export interface JobServiceOptions {
  workspaces: WorkspaceService;
  databasePath: string;
  jobsDirectory: string;
  runners: Readonly<Record<string, RunnerDefinition>>;
}

export interface StartJobInput {
  workspaceId: string;
  runner: string;
  args: string[];
}

export interface PollJobInput {
  jobId: string;
  cursor?: number;
}

export interface PollJobResult {
  job: JobRecord;
  output: string;
  nextCursor: number;
}

export interface JobService {
  startJob(input: StartJobInput): Promise<JobRecord>;
  pollJob(input: PollJobInput): Promise<PollJobResult>;
  readJobOutput(jobId: string): Promise<{ job: JobRecord; content: Buffer }>;
  cancelJob(jobId: string): Promise<JobRecord>;
  listJobs(workspaceId?: string, status?: JobStatus): Promise<JobRecord[]>;
  close(): Promise<void>;
}

type StopReason = "cancelled" | "interrupted" | "timed_out" | "output_limited" | "log_error";

interface ActiveJob {
  child: ChildProcessWithoutNullStreams;
  completion: Promise<void>;
  runner: string;
  workspaceId: string;
  log: WriteStream;
  stopReason: StopReason | null;
  closeObserved: boolean;
  logError: boolean;
}

interface StartingJob {
  runner: string;
  workspaceId: string;
  stopRequested: boolean;
  child?: ChildProcessWithoutNullStreams;
  logPath?: string;
}

const POLL_PAGE_BYTES = 64 * 1024;

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function utf8SequenceLength(content: Buffer, offset: number): number {
  const first = content[offset];
  if (first === undefined || first < 0x80) return 1;
  const sequenceLength = first >= 0xc2 && first <= 0xdf
    ? 2
    : first >= 0xe0 && first <= 0xef
      ? 3
      : first >= 0xf0 && first <= 0xf4
        ? 4
        : 1;
  if (sequenceLength === 1) return 1;
  if (offset + sequenceLength > content.length) return 0;
  for (let index = offset + 1; index < offset + sequenceLength; index += 1) {
    if ((content[index]! & 0xc0) !== 0x80) return 1;
  }
  return sequenceLength;
}

function readUtf8Page(content: Buffer, cursor: number): { output: string; nextCursor: number } {
  const boundedCursor = Math.min(cursor, content.length);
  let start = boundedCursor;
  while (start > 0 && start < content.length && (content[start]! & 0xc0) === 0x80) start -= 1;
  let nextCursor = start;
  while (nextCursor < content.length) {
    const length = utf8SequenceLength(content, nextCursor);
    if (length === 0) break;
    if (nextCursor > start && nextCursor + length > start + POLL_PAGE_BYTES) break;
    nextCursor += length;
    if (nextCursor >= start + POLL_PAGE_BYTES) break;
  }
  if (nextCursor === start && start < content.length) {
    nextCursor += utf8SequenceLength(content, start);
  }
  return {
    output: content.subarray(start, nextCursor).toString("utf8"),
    nextCursor,
  };
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const onClose = (): void => settle(true);
    const settle = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("close", onClose);
      resolve(exited);
    };
    const timeout = setTimeout(() => settle(child.exitCode !== null), timeoutMs);
    child.once("close", onClose);
  });
}

async function terminateWindowsProcess(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    const timeout = setTimeout(() => {
      killer.kill();
      finish();
    }, 3000);
    killer.once("error", finish);
    killer.once("close", finish);
  });
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    if (child.exitCode === null) await terminateWindowsProcess(child.pid);
    if (child.exitCode === null) child.kill();
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Continue to the forced child kill below if the graceful fallback failed.
    }
  }
  if (child.exitCode === null) await waitForChildExit(child, 1000);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The process group may not exist; force the known child below.
    }
  }
  if (child.exitCode === null) await waitForChildExit(child, 1000);
  if (child.exitCode === null) {
    try { child.kill("SIGKILL"); } catch { /* The child exited concurrently. */ }
    await waitForChildExit(child, 1000);
  }
}

async function readWindowsProcessIdentity(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    const powershell = systemRoot === undefined
      ? "powershell.exe"
      : path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = `[Console]::Out.Write(([System.Diagnostics.Process]::GetProcessById(${String(pid)}).StartTime.ToUniversalTime().Ticks))`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timeout = setTimeout(() => {
      child.kill();
      finish(null);
    }, 3000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (output.length < 4096) output += String(chunk);
    });
    child.stdout?.on("error", () => finish(null));
    child.once("error", () => finish(null));
    child.once("close", (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      finish(/^\s*(\d+)\s*$/u.exec(output)?.[1] ?? null);
    });
  });
}

async function readProcessIdentity(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") return readWindowsProcessIdentity(pid);
  try {
    const stat = (await readFile(`/proc/${String(pid)}/stat`)).toString("utf8");
    const closingParenthesis = stat.lastIndexOf(")");
    if (closingParenthesis < 0) return null;
    const fields = stat.slice(closingParenthesis + 2).trim().split(/\s+/u);
    return fields[19] ?? null;
  } catch {
    // Platforms without procfs cannot provide a safe start-time identity.
    return null;
  }
}

async function terminatePersistedProcess(processRecord: RecoverableJobProcess): Promise<void> {
  if (
    !Number.isInteger(processRecord.pid) || processRecord.pid <= 0
    || typeof processRecord.pidStartToken !== "string" || processRecord.pidStartToken.length === 0
  ) return;
  // POSIX and Windows expose identity observation and signaling as separate syscalls;
  // there is no OS-level CAS. Re-check before escalation and fail closed on uncertainty.
  const currentToken = await readProcessIdentity(processRecord.pid);
  if (currentToken === null || currentToken !== processRecord.pidStartToken) return;
  if (process.platform === "win32") {
    await terminateWindowsProcess(processRecord.pid);
    return;
  }

  try {
    process.kill(-processRecord.pid, "SIGTERM");
  } catch {
    try {
      process.kill(processRecord.pid, "SIGTERM");
    } catch {
      return;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (await readProcessIdentity(processRecord.pid) !== processRecord.pidStartToken) return;
  try {
    process.kill(-processRecord.pid, "SIGKILL");
  } catch {
    try {
      process.kill(processRecord.pid, "SIGKILL");
    } catch {
      // The process exited between the identity check and the signal.
    }
  }
}

async function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => {
      reject(new Error(`Runner failed to start: ${error.message}`));
    });
  });
}

async function closeLog(log: WriteStream): Promise<void> {
  if (log.destroyed || log.closed) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(settle, 1000);
    log.once("finish", settle);
    log.once("close", settle);
    log.once("error", settle);
    try {
      log.end(settle);
    } catch {
      settle();
    }
  });
}

export async function createJobService(options: JobServiceOptions): Promise<JobService> {
  await mkdir(options.jobsDirectory, { recursive: true });
  const store = new JobStore(options.databasePath);
  try {
    await Promise.all(store.listRecoverableProcesses().map(terminatePersistedProcess));
    store.interruptNonterminal();
    await Promise.all(store.pruneTerminal(1000).map((logPath) => rm(logPath, { force: true })));
  } catch (error) {
    store.close();
    throw error;
  }

  const activeJobs = new Map<string, ActiveJob>();
  const startingJobs = new Map<string, StartingJob>();
  const startingPromises = new Set<Promise<JobRecord>>();
  const logReadLeases = new Map<string, number>();
  const logReadOperations = new Set<Promise<void>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const withLogReadLease = async <T>(jobId: string, operation: () => Promise<T>): Promise<T> => {
    let release!: () => void;
    const lease = new Promise<void>((resolve) => { release = resolve; });
    logReadOperations.add(lease);
    logReadLeases.set(jobId, (logReadLeases.get(jobId) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const count = logReadLeases.get(jobId) ?? 0;
      if (count <= 1) logReadLeases.delete(jobId);
      else logReadLeases.set(jobId, count - 1);
      logReadOperations.delete(lease);
      release();
    }
  };

  const requestStop = (active: ActiveJob, reason: StopReason): void => {
    if (active.stopReason === null) active.stopReason = reason;
    if (active.closeObserved) return;
    void terminateProcessTree(active.child).catch(() => undefined);
  };

  return {
    async startJob(input: StartJobInput): Promise<JobRecord> {
      if (closing) throw new Error("Job service is closing");
      const runner = options.runners[input.runner];
      if (runner === undefined) throw new Error("Runner is not configured");
      if (
        input.args.some((argument) => typeof argument !== "string" || argument.includes("\0")) ||
        !runner.validateArgs(input.args)
      ) {
        throw new Error("Runner arguments are not allowed");
      }
      const activeForRunner = [...activeJobs.values()].filter(
        (active) => active.runner === input.runner && active.child.exitCode === null,
      );
      const startingForRunner = [...startingJobs.values()].filter(
        (starting) => starting.runner === input.runner,
      );
      if (activeForRunner.length + startingForRunner.length >= runner.maxConcurrent) {
        throw new Error("Runner concurrency limit reached");
      }
      const maxConcurrentPerWorkspace = runner.maxConcurrentPerWorkspace ?? runner.maxConcurrent;
      const workspaceConcurrent = activeForRunner.filter(
        (active) => active.workspaceId === input.workspaceId,
      ).length + startingForRunner.filter(
        (starting) => starting.workspaceId === input.workspaceId,
      ).length;
      if (workspaceConcurrent >= maxConcurrentPerWorkspace) {
        throw new Error("Runner concurrency limit reached for workspace");
      }

      const reservationId = randomUUID();
      const reservation: StartingJob = {
        runner: input.runner,
        workspaceId: input.workspaceId,
        stopRequested: false,
      };
      startingJobs.set(reservationId, reservation);
      const startup = (async (): Promise<JobRecord> => {
        let child: ChildProcessWithoutNullStreams | undefined;
        let logPath: string | undefined;
        let id: string | undefined;
        let inserted = false;
        let log: WriteStream | undefined;
        try {
          const cwd = await options.workspaces.resolveWorkspaceRoot(input.workspaceId);
          if (closing || reservation.stopRequested) throw new Error("Job service is closing");
          const command = runner.resolveCommand === undefined
            ? { executable: runner.executable, args: [...(runner.prefixArgs ?? []), ...input.args] }
            : await runner.resolveCommand(input.args, cwd);
          if (closing || reservation.stopRequested) throw new Error("Job service is closing");
          id = randomUUID();
          logPath = path.join(options.jobsDirectory, `${id}.log`);
          reservation.logPath = logPath;
          await writeFile(logPath, "", { flag: "wx" });
          if (closing || reservation.stopRequested) throw new Error("Job service is closing");
          child = spawn(command.executable, command.args, {
            cwd,
            env: runner.inheritEnvironment === true
              ? { ...process.env, ...runner.environment }
              : { ...runner.environment },
            shell: false,
            windowsHide: true,
            detached: process.platform !== "win32",
          });
          reservation.child = child;
          await waitForSpawn(child);
          if (child.pid === undefined) throw new Error("Runner failed to start");
          if (closing || reservation.stopRequested) {
            await terminateProcessTree(child);
            throw new Error("Job service is closing");
          }
          const timestamp = new Date().toISOString();
          const record: JobRecord = {
            id,
            workspaceId: input.workspaceId,
            runner: input.runner,
            args: [...input.args],
            status: "running",
            pid: child.pid,
            exitCode: null,
            error: null,
            logPath,
            createdAt: timestamp,
            startedAt: timestamp,
            finishedAt: null,
          };
          log = createWriteStream(logPath, { flags: "a" });
          const activeLog = log;
          const activeChild = child;
          const active: ActiveJob = {
            child: activeChild,
            completion: Promise.resolve(),
            runner: input.runner,
            workspaceId: input.workspaceId,
            log: activeLog,
            stopReason: null,
            closeObserved: false,
            logError: false,
          };
          activeLog.on("error", () => {
            active.logError = true;
            requestStop(active, "log_error");
            activeLog.destroy();
          });
          let outputBytes = 0;
          const onData = (chunk: Buffer): void => {
            if (active.logError || active.closeObserved) return;
            const remaining = runner.maxOutputBytes - outputBytes;
            if (remaining <= 0) return;
            const bounded = chunk.subarray(0, remaining);
            outputBytes += bounded.length;
            try {
              activeLog.write(bounded);
            } catch {
              active.logError = true;
              requestStop(active, "log_error");
            }
            if (bounded.length < chunk.length || outputBytes >= runner.maxOutputBytes) {
              requestStop(active, "output_limited");
            }
          };
          activeChild.stdout.on("data", onData);
          activeChild.stderr.on("data", onData);
          const onStreamError = (): void => {
            active.logError = true;
            requestStop(active, "log_error");
          };
          activeChild.stdout.on("error", onStreamError);
          activeChild.stderr.on("error", onStreamError);
          const pidStartToken = activeChild.exitCode === null
            ? await readProcessIdentity(activeChild.pid!)
            : null;
          const childExitedBeforePersist = activeChild.exitCode !== null;
          if (closing || reservation.stopRequested) {
            await terminateProcessTree(activeChild);
            throw new Error("Job service is closing");
          }
          store.insert(
            childExitedBeforePersist || pidStartToken === null ? { ...record, pid: null } : record,
            pidStartToken,
          );
          inserted = true;
          const timeout = setTimeout(
            () => requestStop(active, "timed_out"),
            runner.maxTimeoutSeconds * 1000,
          );
          let finalizeCompleted: ((code: number | null) => void) | undefined;
          active.completion = new Promise<void>((resolve) => {
            let finalized = false;
            const finalize = async (code: number | null, spawnError?: string): Promise<void> => {
              if (finalized) return;
              finalized = true;
              clearTimeout(timeout);
              await closeLog(log!);
              const reason = active.stopReason;
              const status: JobStatus = reason === "cancelled"
                ? "cancelled"
                : reason === "interrupted"
                  ? "interrupted"
                  : reason === "timed_out"
                    ? "timed_out"
                    : reason === "output_limited" || reason === "log_error" || spawnError !== undefined || code !== 0
                      ? "failed"
                      : "completed";
              const error = reason === "cancelled"
                ? "Cancelled by user"
                : reason === "interrupted"
                  ? "Service stopped"
                  : reason === "timed_out"
                    ? "Runner timed out"
                    : reason === "output_limited"
                      ? "Runner output limit exceeded"
                      : reason === "log_error"
                        ? "Job output log failed"
                        : spawnError ?? (code === 0 ? null : `Runner exited with code ${String(code)}`);
              try {
                store.finish(id!, status, code, error);
                const obsoleteLogs = store.pruneTerminal(1000, [...logReadLeases.keys()]);
                await Promise.allSettled(obsoleteLogs.map((obsoleteLog) => rm(obsoleteLog, { force: true })));
              } finally {
                activeJobs.delete(id!);
                resolve();
              }
            };
            finalizeCompleted = (code) => { void finalize(code); };
            activeChild.on("error", (error) => {
              void finalize(null, error.message);
            });
            activeChild.on("close", (code) => {
              active.closeObserved = true;
              void finalize(code);
            });
          });
          activeJobs.set(id, active);
          if (activeChild.exitCode !== null) finalizeCompleted?.(activeChild.exitCode);
          return record;
        } catch (error) {
          if (inserted && id !== undefined) {
            try {
              store.finish(id, "failed", child?.exitCode ?? null, "Runner startup failed");
            } catch {
              // The service closes only after startup promises settle; this is a final fallback.
            }
          }
          if (child !== undefined) await terminateProcessTree(child).catch(() => undefined);
          if (log !== undefined) {
            log.destroy();
            await closeLog(log);
          }
          if (logPath !== undefined) await rm(logPath, { force: true }).catch(() => undefined);
          throw error;
        }
      })();
      startingPromises.add(startup);
      try {
        return await startup;
      } finally {
        startingPromises.delete(startup);
        startingJobs.delete(reservationId);
      }
    },

    async pollJob(input: PollJobInput): Promise<PollJobResult> {
      const cursor = input.cursor ?? 0;
      if (!Number.isInteger(cursor) || cursor < 0) {
        throw new Error("cursor must be a non-negative integer");
      }
      if (closing) throw new Error("Job service is closing");
      return withLogReadLease(input.jobId, async () => {
        const job = store.get(input.jobId);
        if (job === undefined) throw new Error("Job not found");
        let content: Buffer;
        try {
          content = await readFile(job.logPath);
        } catch (error) {
          if (!isMissingFile(error)) throw error;
          content = Buffer.alloc(0);
        }
        const page = readUtf8Page(content, cursor);
        return { job: store.get(input.jobId) ?? job, ...page };
      });
    },

    async readJobOutput(jobId: string): Promise<{ job: JobRecord; content: Buffer }> {
      if (closing) throw new Error("Job service is closing");
      return withLogReadLease(jobId, async () => {
        const job = store.get(jobId);
        if (job === undefined) throw new Error("Job not found");
        try {
          return { job: store.get(jobId) ?? job, content: await readFile(job.logPath) };
        } catch (error) {
          if (!isMissingFile(error)) throw error;
          return { job: store.get(jobId) ?? job, content: Buffer.alloc(0) };
        }
      });
    },

    async cancelJob(jobId: string): Promise<JobRecord> {
      const job = store.get(jobId);
      if (job === undefined) throw new Error("Job not found");
      const active = activeJobs.get(jobId);
      if (active === undefined) return job;
      if (!active.closeObserved) {
        if (active.stopReason === null) active.stopReason = "cancelled";
        await terminateProcessTree(active.child);
      }
      await active.completion;
      return store.get(jobId) ?? job;
    },

    async listJobs(workspaceId?: string, status?: JobStatus): Promise<JobRecord[]> {
      return store.list(workspaceId, status);
    },

    async close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      closePromise = (async () => {
        for (const starting of startingJobs.values()) {
          starting.stopRequested = true;
          if (starting.child !== undefined) {
            await terminateProcessTree(starting.child).catch(() => undefined);
          }
        }
        await Promise.allSettled([...startingPromises]);
        for (const active of activeJobs.values()) {
          if (!active.closeObserved) {
            if (active.stopReason === null) active.stopReason = "interrupted";
            await terminateProcessTree(active.child).catch(() => undefined);
          }
        }
        await Promise.all([...activeJobs.values()].map((active) => active.completion));
        await Promise.allSettled([...logReadOperations]);
        store.close();
      })();
      return closePromise;
    },
  };
}
