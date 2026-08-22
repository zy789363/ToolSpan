import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { hash } from "bcryptjs";

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error("Pipe the owner password on stdin; command-line password arguments are not accepted");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk as Uint8Array);
    length += buffer.length;
    if (length > 1024) throw new Error("Password input is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/u, "");
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const fileIndex = arguments_.indexOf("--file");
  const output = fileIndex < 0 ? undefined : arguments_[fileIndex + 1];
  if (output === undefined) throw new Error("Usage: password:init -- --file <path> [--force]");
  const password = await readPassword();
  if (password.length < 12 || password.length > 128) {
    throw new Error("Owner password must contain 12 to 128 characters");
  }
  const absolutePath = path.resolve(output);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${await hash(password, 12)}\n`, {
    flag: arguments_.includes("--force") ? "w" : "wx",
    mode: 0o600,
  });
  process.stdout.write(`Wrote bcrypt owner password hash to ${absolutePath}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Password initialization failed"}\n`);
  process.exitCode = 1;
});
