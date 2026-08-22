import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

export const FIXED_DESKTOP_HOST_RESOURCE = "desktop-host/main.js";
export const DESKTOP_RESOURCE_HELLO_DEADLINE_MS = 10_000;
export const DESKTOP_RESOURCE_OUTPUT_LIMIT_BYTES = 64 * 1024;

function boundedOutput(limitBytes) {
  const chunks = [];
  let capturedBytes = 0;
  let truncated = false;
  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const acceptedBytes = Math.min(buffer.length, Math.max(0, limitBytes - capturedBytes));
      if (acceptedBytes > 0) {
        chunks.push(acceptedBytes === buffer.length
          ? buffer
          : Buffer.from(buffer.subarray(0, acceptedBytes)));
        capturedBytes += acceptedBytes;
      }
      if (acceptedBytes < buffer.length) truncated = true;
    },
    result() {
      return {
        text: Buffer.concat(chunks, capturedBytes).toString("utf8"),
        truncated,
      };
    },
  };
}

function safeTarget(root, configuredTarget) {
  const normalized = configuredTarget.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error("Desktop resource target must stay inside the resource root");
  }
  return path.join(root, ...normalized.split("/").filter(Boolean));
}

async function copyDirectoryContents(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) await copyDirectoryContents(sourcePath, targetPath);
    else if (entry.isFile()) {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    } else {
      throw new Error("Desktop resources must contain only files and directories");
    }
  }
}

export async function stageDesktopResources({ configPath, resourceRoot, resources }) {
  const configDirectory = path.dirname(configPath);
  await mkdir(resourceRoot, { recursive: true });
  for (const [configuredSource, configuredTarget] of Object.entries(resources)) {
    const source = path.resolve(configDirectory, configuredSource);
    const target = safeTarget(resourceRoot, configuredTarget);
    const sourceStat = await stat(source);
    if (sourceStat.isDirectory()) await copyDirectoryContents(source, target);
    else if (sourceStat.isFile()) {
      const fileTarget = configuredTarget === "" ? path.join(target, path.basename(source)) : target;
      await mkdir(path.dirname(fileTarget), { recursive: true });
      await copyFile(source, fileTarget);
    } else {
      throw new Error("Desktop resource source must be a file or directory");
    }
  }
}

export async function runDesktopResourceHello({
  nodeExecutable = process.execPath,
  resourceRoot,
  request,
  deadlineMs = DESKTOP_RESOURCE_HELLO_DEADLINE_MS,
  outputLimitBytes = DESKTOP_RESOURCE_OUTPUT_LIMIT_BYTES,
}) {
  const child = spawn(nodeExecutable, ["--no-warnings", path.join(resourceRoot, FIXED_DESKTOP_HOST_RESOURCE)], {
    cwd: resourceRoot,
    env: process.platform === "win32" && process.env.SystemRoot !== undefined
      ? { SystemRoot: process.env.SystemRoot }
      : {},
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = boundedOutput(outputLimitBytes);
  const stderr = boundedOutput(outputLimitBytes);
  child.stdout.on("data", (chunk) => stdout.append(chunk));
  child.stderr.on("data", (chunk) => stderr.append(chunk));
  child.stdin.on("error", () => {});
  child.stdin.end(request);
  let spawnError;
  let timedOut = false;
  const exitCode = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, deadlineMs);
    deadline.unref();
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code) => {
      clearTimeout(deadline);
      const stdoutResult = stdout.result();
      const stderrResult = stderr.result();
      if (timedOut) {
        const error = new Error(`Desktop resource host exceeded its ${deadlineMs} ms deadline`);
        error.code = "DESKTOP_RESOURCE_HELLO_TIMEOUT";
        error.stdout = stdoutResult.text;
        error.stderr = stderrResult.text;
        error.stdoutTruncated = stdoutResult.truncated;
        error.stderrTruncated = stderrResult.truncated;
        reject(error);
      } else if (spawnError !== undefined) {
        reject(spawnError);
      } else {
        resolve({ code, stdoutResult, stderrResult });
      }
    });
  });
  return {
    exitCode: exitCode.code,
    stdout: exitCode.stdoutResult.text,
    stderr: exitCode.stderrResult.text,
    stdoutTruncated: exitCode.stdoutResult.truncated,
    stderrTruncated: exitCode.stderrResult.truncated,
  };
}
