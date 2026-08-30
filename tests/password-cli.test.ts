import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { compare } from "bcryptjs";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("password initialization CLI", () => {
  it("reads the password from stdin and writes only a bcrypt hash", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "webgpt-password-"));
    temporaryDirectories.push(directory);
    const output = path.join(directory, "owner.bcrypt");
    const cli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
    const script = path.resolve("src", "cli", "init-password.ts");
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, script, "--file", output], {
        cwd: process.cwd(),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.once("error", reject);
      child.once("close", resolve);
      child.stdin.end("a-strong-owner-password\n");
    });
    expect(exitCode).toBe(0);
    const stored = (await readFile(output, "utf8")).trim();
    expect(stored).not.toContain("a-strong-owner-password");
    await expect(compare("a-strong-owner-password", stored)).resolves.toBe(true);
  });

  it("rejects passwords shorter than eight characters before creating a hash file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "webgpt-password-short-"));
    temporaryDirectories.push(directory);
    const output = path.join(directory, "owner.bcrypt");
    const cli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
    const script = path.resolve("src", "cli", "init-password.ts");
    let stderr = "";
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, script, "--file", output], {
        cwd: process.cwd(),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("error", reject);
      child.once("close", resolve);
      child.stdin.end("1234567\n");
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("8 to 128 characters");
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
