import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function npmCli() {
  if (typeof process.env.npm_execpath === "string" && await exists(process.env.npm_execpath)) {
    return process.env.npm_execpath;
  }
  const candidate = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return await exists(candidate) ? candidate : null;
}

async function run(label, command, arguments_) {
  process.stdout.write(`[verify:core] ${label}\n`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: projectRoot,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) throw new Error(`${label} failed with exit code ${String(code)}`);
}

const npmExecPath = await npmCli();
if (npmExecPath === null) throw new Error("Could not locate npm CLI without using a command shell");
const npm = (...arguments_) => [process.execPath, [npmExecPath, ...arguments_]];
const steps = [
  ["script unit tests", process.execPath, ["--test", "scripts/tests/goal-scripts.test.mjs"]],
  ["goal contract", ...npm("run", "goal:check")],
  ["TypeScript typecheck", ...npm("run", "typecheck")],
  ["Core tests", ...npm("test")],
  ["Core build", ...npm("run", "build")],
  ["installed runtime structure", ...npm("run", "preflight", "--", "--check-only")],
  ["MCP Tool Contract", ...npm("run", "check:contract")],
  ["brand", ...npm("run", "check:brand")],
  ["version", ...npm("run", "check:version")],
  ["OpenAI usage snapshot", ...npm("run", "check:openai-plan-usage")],
  ["documentation", ...npm("run", "check:docs")],
  ["open-source files", ...npm("run", "check:oss")],
  ["CI policy", ...npm("run", "check:ci")],
];

try {
  for (const [label, command, arguments_] of steps) await run(label, command, arguments_);
  process.stdout.write(`${JSON.stringify({ status: "PASS", checks: steps.map(([label]) => label) })}\n`);
} catch (error) {
  process.stderr.write(`[verify:core] ${error instanceof Error ? error.message : "verification failed"}\n`);
  process.exitCode = 1;
}
