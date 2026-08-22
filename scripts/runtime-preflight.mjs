import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isSupportedNodeVersion, SUPPORTED_NODE_ENGINE } from "./package-runtime-policy.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.slice(2).includes("--check-only");
const doctorArguments = process.argv.slice(2).filter((argument) => argument !== "--check-only");

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runDoctor(entry) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...doctorArguments], {
      cwd: projectRoot,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill(), 20_000);
    child.stdout.resume();
    child.stderr.resume();
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

try {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const requiredFiles = ["dist/main.js", "dist/cli/init-password.js", "dist/cli/doctor.js"];
  const files = Object.fromEntries(await Promise.all(requiredFiles.map(async (relativePath) => [
    relativePath,
    await exists(path.join(projectRoot, relativePath)),
  ])));
  const dependencyNames = Object.keys(packageJson.dependencies ?? {});
  const dependencyPresence = await Promise.all(dependencyNames.map(async (name) => await exists(
    path.join(projectRoot, "node_modules", ...name.split("/"), "package.json"),
  )));
  const missingDependencies = dependencyNames.filter((_name, index) => !dependencyPresence[index]);
  const engineSatisfied = packageJson.engines?.node === SUPPORTED_NODE_ENGINE
    && isSupportedNodeVersion(process.version);
  const artifactsPresent = Object.values(files).every(Boolean);
  const doctor = checkOnly || !artifactsPresent
    ? (checkOnly ? "NOT_RUN_CHECK_ONLY" : "NOT_RUN_MISSING_ARTIFACT")
    : (await runDoctor(path.join(projectRoot, "dist", "cli", "doctor.js")) ? "PASS" : "FAIL");
  const passed = engineSatisfied && artifactsPresent && missingDependencies.length === 0
    && (checkOnly || doctor === "PASS");
  process.stdout.write(`${JSON.stringify({
    status: passed ? "PASS" : "FAIL",
    mode: checkOnly ? "check-only" : "runtime",
    node: { version: process.version, required: packageJson.engines?.node ?? null, satisfied: engineSatisfied },
    compiledArtifacts: files,
    productionDependencies: { count: dependencyNames.length, missing: missingDependencies },
    doctor,
  }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    status: "FAIL",
    error: error instanceof Error ? error.message : "Runtime preflight failed",
  }, null, 2)}\n`);
  process.exitCode = 1;
}
