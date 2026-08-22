import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { hash } from "bcryptjs";
import { afterEach, describe, expect, it } from "vitest";

import { SERVICE_INFO } from "../src/service-info.js";

const temporaryDirectories: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const childClosures = new Map<ChildProcessWithoutNullStreams, Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>>();

afterEach(async () => {
  const activeChildren = children.splice(0);
  for (const child of activeChildren) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await Promise.all(activeChildren.map(async (child) => {
    await childClosures.get(child);
    childClosures.delete(child);
  }));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not select a port");
  await new Promise<void>((resolve, reject) => server.close((error) => {
    if (error === undefined) resolve();
    else reject(error);
  }));
  return address.port;
}

describe("server process", () => {
  it("starts from a config file, serves health, and terminates on request", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "webgpt-process-"));
    temporaryDirectories.push(directory);
    const projects = path.join(directory, "projects");
    const secrets = path.join(directory, "secrets");
    await mkdir(projects);
    await mkdir(secrets);
    await writeFile(path.join(secrets, "owner.bcrypt"), await hash("owner-password", 4));
    const port = await availablePort();
    const configPath = path.join(directory, "webgpt.config.json");
    await writeFile(configPath, JSON.stringify({
      host: "127.0.0.1",
      port,
      publicBaseUrl: `http://127.0.0.1:${String(port)}`,
      allowedRoots: [projects],
      stateDirectory: path.join(directory, "state"),
      ownerPasswordHashFile: path.join(secrets, "owner.bcrypt"),
    }));

    const builtEntry = path.resolve("dist", "main.js");
    const entryArguments = existsSync(builtEntry)
      ? [builtEntry]
      : [
          path.resolve("node_modules", "tsx", "dist", "cli.mjs"),
          path.resolve("src", "main.ts"),
        ];
    const child = spawn(process.execPath, entryArguments, {
      cwd: process.cwd(),
      env: { ...process.env, TOOLSPAN_CONFIG: configPath, WEBGPT_CONFIG: undefined },
      shell: false,
      windowsHide: true,
    });
    children.push(child);
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once("close", (code, signal) => resolve({ code, signal })),
    );
    childClosures.set(child, closed);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Startup timed out: ${stderr}`)), 10_000);
      const check = (): void => {
        if (stdout.includes(`${SERVICE_INFO.package} listening`)) {
          clearTimeout(timeout);
          resolve();
        }
      };
      child.stdout.on("data", check);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Server exited with ${String(code)}: ${stderr}`));
      });
    });

    const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: SERVICE_INFO.service,
      version: SERVICE_INFO.version,
    });
    child.kill("SIGTERM");
    const termination = await closed;
    expect(
      termination.code === 0 || termination.signal === "SIGTERM",
    ).toBe(true);
  }, 15_000);
});
