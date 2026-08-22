import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceService } from "../workspaces/workspace-service.js";
import { JobStore } from "./job-store.js";

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
  maxTimeoutSeconds: number;
  maxOutputBytes: number;
  environment?: Readonly<Record<string, string>>;
  inheritEnvironment?: boolean;
  requiredFiles?: readonly string[];
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

interface ActiveJob {
  child: ChildProcessWithoutNullStreams;
  completion: Promise<void>;
  runner: string;
  cancelled: boolean;
  interrupted: boolean;
  timedOut: boolean;
  outputLimited: boolean;
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
    });
    killer.once("error", () => {
      child.kill();
      resolve();
    });
    killer.once("close", () => resolve());
  });
}

async function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => {
      reject(new Error(`Runner failed to start: ${error.message}`));
    });
  });
}

export async function createJobService(options: JobServiceOptions): Promise<JobService> {
  await mkdir(options.jobsDirectory, { recursive: true });
  const store = new JobStore(options.databasePath);
  store.interruptNonterminal();
  await Promise.all(store.pruneTerminal(1000).map((logPath) => rm(logPath, { force: true })));
  const activeJobs = new Map<string, ActiveJob>();

  return {
    async startJob(input: StartJobInput): Promise<JobRecord> {
      const runner = options.runners[input.runner];
      if (runner === undefined) {
        throw new Error("Runner is not configured");
      }
      if (
        input.args.some((argument) => typeof argument !== "string" || argument.includes("\0")) ||
        !runner.validateArgs(input.args)
      ) {
        throw new Error("Runner arguments are not allowed");
      }
      const concurrent = [...activeJobs.values()].filter(
        (active) => active.runner === input.runner && active.child.exitCode === null,
      ).length;
      if (concurrent >= runner.maxConcurrent) {
        throw new Error("Runner concurrency limit reached");
      }

      const cwd = await options.workspaces.resolveWorkspaceRoot(input.workspaceId);
      const command = runner.resolveCommand === undefined
        ? { executable: runner.executable, args: [...(runner.prefixArgs ?? []), ...input.args] }
        : await runner.resolveCommand(input.args, cwd);
      const id = randomUUID();
      const logPath = path.join(options.jobsDirectory, `${id}.log`);
      await writeFile(logPath, "", { flag: "wx" });
      const child = spawn(command.executable, command.args, {
        cwd,
        env: runner.inheritEnvironment === true
          ? { ...process.env, ...runner.environment }
          : { ...runner.environment },
        shell: false,
        windowsHide: true,
      });
      await waitForSpawn(child);
      if (child.pid === undefined) {
        throw new Error("Runner failed to start");
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
      store.insert(record);

      const log = createWriteStream(logPath, { flags: "a" });
      let outputBytes = 0;
      const active: ActiveJob = {
        child,
        completion: Promise.resolve(),
        runner: input.runner,
        cancelled: false,
        interrupted: false,
        timedOut: false,
        outputLimited: false,
      };
      const onData = (chunk: Buffer): void => {
        const remaining = runner.maxOutputBytes - outputBytes;
        if (remaining <= 0) return;
        const bounded = chunk.subarray(0, remaining);
        outputBytes += bounded.length;
        log.write(bounded);
        if (bounded.length < chunk.length || outputBytes >= runner.maxOutputBytes) {
          active.outputLimited = true;
          void terminateProcessTree(child);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      const timeout = setTimeout(() => {
        active.timedOut = true;
        void terminateProcessTree(child);
      }, runner.maxTimeoutSeconds * 1000);

      active.completion = new Promise((resolve) => {
        let finalized = false;
        const finalize = (code: number | null, spawnError?: string): void => {
          if (finalized) return;
          finalized = true;
          clearTimeout(timeout);
          log.end(() => {
            const status: JobStatus = active.cancelled
              ? "cancelled"
              : active.interrupted
                ? "interrupted"
                : active.timedOut
                  ? "timed_out"
                  : active.outputLimited || spawnError !== undefined || code !== 0
                    ? "failed"
                    : "completed";
            const error = active.cancelled
              ? "Cancelled by user"
              : active.interrupted
                ? "Service stopped"
                : active.timedOut
                  ? "Runner timed out"
                  : active.outputLimited
                    ? "Runner output limit exceeded"
                    : spawnError ?? (code === 0 ? null : `Runner exited with code ${String(code)}`);
            store.finish(id, status, code, error);
            const obsoleteLogs = store.pruneTerminal(1000);
            void Promise.all(obsoleteLogs.map((obsoleteLog) => rm(obsoleteLog, { force: true })))
              .finally(() => {
                activeJobs.delete(id);
                resolve();
              });
          });
        };
        child.on("error", (error) => {
          finalize(null, error.message);
        });
        child.on("close", (code) => {
          finalize(code);
        });
      });
      activeJobs.set(id, active);
      return record;
    },

    async pollJob(input: PollJobInput): Promise<PollJobResult> {
      const cursor = input.cursor ?? 0;
      if (!Number.isInteger(cursor) || cursor < 0) {
        throw new Error("cursor must be a non-negative integer");
      }
      const job = store.get(input.jobId);
      if (job === undefined) {
        throw new Error("Job not found");
      }
      const content = await readFile(job.logPath);
      const boundedCursor = Math.min(cursor, content.length);
      const chunk = content.subarray(boundedCursor, boundedCursor + 64 * 1024);
      const output = chunk.toString("utf8");
      return {
        job,
        output,
        nextCursor: boundedCursor + chunk.length,
      };
    },

    async readJobOutput(jobId: string): Promise<{ job: JobRecord; content: Buffer }> {
      const job = store.get(jobId);
      if (job === undefined) {
        throw new Error("Job not found");
      }
      return { job, content: await readFile(job.logPath) };
    },

    async cancelJob(jobId: string): Promise<JobRecord> {
      const job = store.get(jobId);
      if (job === undefined) {
        throw new Error("Job not found");
      }
      const active = activeJobs.get(jobId);
      if (active === undefined) return job;
      active.cancelled = true;
      await terminateProcessTree(active.child);
      await active.completion;
      const cancelled = store.get(jobId);
      if (cancelled === undefined) throw new Error("Job not found after cancellation");
      return cancelled;
    },

    async listJobs(workspaceId?: string, status?: JobStatus): Promise<JobRecord[]> {
      return store.list(workspaceId, status);
    },

    async close(): Promise<void> {
      for (const active of activeJobs.values()) {
        active.interrupted = true;
        await terminateProcessTree(active.child);
      }
      await Promise.all([...activeJobs.values()].map((active) => active.completion));
      store.close();
    },
  };
}
