import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const LITERAL_SEMVER = /["'](\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)["']/gu;

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(projectRoot, relativePath), "utf8"));
}

async function sourceFiles(directory) {
  if (!await exists(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return await sourceFiles(entryPath);
    return /\.(?:[cm]?[jt]sx?|rs)$/u.test(entry.name) ? [entryPath] : [];
  }));
  return nested.flat();
}

function compare(errors, source, actual, expected) {
  if (actual !== expected) errors.push(`${source}: expected ${expected}, found ${String(actual)}`);
}

const errors = [];
try {
  const packageJson = await readJson("package.json");
  const expected = packageJson.version;
  if (typeof expected !== "string" || !SEMVER.test(expected)) {
    errors.push("package.json.version: expected a valid semantic version");
  }

  const lock = await readJson("package-lock.json");
  compare(errors, "package-lock.json.version", lock.version, expected);
  compare(errors, "package-lock.json.packages[''].version", lock.packages?.[""]?.version, expected);
  compare(errors, "package-lock.json.name", lock.name, packageJson.name);
  compare(errors, "package-lock.json.packages[''].name", lock.packages?.[""]?.name, packageJson.name);

  if (await exists(path.join(projectRoot, "apps", "desktop", "package.json"))) {
    const desktopPackage = await readJson(path.join("apps", "desktop", "package.json"));
    compare(errors, "apps/desktop/package.json.version", desktopPackage.version, expected);
    if (await exists(path.join(projectRoot, "apps", "desktop", "package-lock.json"))) {
      const desktopLock = await readJson(path.join("apps", "desktop", "package-lock.json"));
      compare(errors, "apps/desktop/package-lock.json.version", desktopLock.version, expected);
      compare(errors, "apps/desktop/package-lock.json.packages[''].version", desktopLock.packages?.[""]?.version, expected);
    }
  }

  const cargoPath = path.join(projectRoot, "apps", "desktop", "src-tauri", "Cargo.toml");
  if (await exists(cargoPath)) {
    const cargo = await readFile(cargoPath, "utf8");
    const packageSection = /^\[package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/mu.exec(cargo)?.[1] ?? "";
    const cargoVersion = /^version\s*=\s*"([^"]+)"\s*$/mu.exec(packageSection)?.[1];
    compare(errors, "apps/desktop/src-tauri/Cargo.toml package.version", cargoVersion, expected);
  }

  const tauriPath = path.join(projectRoot, "apps", "desktop", "src-tauri", "tauri.conf.json");
  if (await exists(tauriPath)) {
    const tauri = await readJson(path.join("apps", "desktop", "src-tauri", "tauri.conf.json"));
    if (tauri.version !== undefined) compare(errors, "apps/desktop/src-tauri/tauri.conf.json.version", tauri.version, expected);
  }

  const runtimeRoots = [path.join(projectRoot, "src"), path.join(projectRoot, "apps", "desktop", "src")];
  const files = (await Promise.all(runtimeRoots.map(sourceFiles))).flat();
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const match of content.matchAll(LITERAL_SEMVER)) {
      errors.push(`${path.relative(projectRoot, file).replaceAll(path.sep, "/")}: hard-coded runtime version ${match[1]}`);
    }
  }

  process.stdout.write(`${JSON.stringify({
    status: errors.length === 0 ? "PASS" : "FAIL",
    canonicalVersion: expected ?? null,
    checkedRuntimeSourceFiles: files.length,
    errors,
  }, null, 2)}\n`);
  if (errors.length > 0) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    status: "FAIL",
    errors: [error instanceof Error ? error.message : "Version check failed"],
  }, null, 2)}\n`);
  process.exitCode = 1;
}
