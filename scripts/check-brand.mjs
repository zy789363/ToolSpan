import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([".git", ".toolspan-dev", "coverage", "dist", "node_modules", "target", "vendor-inputs"]);
const textExtensions = new Set(["", ".cjs", ".css", ".html", ".js", ".json", ".md", ".mjs", ".ps1", ".rs", ".toml", ".ts", ".tsx", ".yml", ".yaml"]);
const legacyPattern = /web[ _-]?gpt/giu;

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await walk(entryPath));
    else if (entry.isFile() && textExtensions.has(path.extname(entry.name))) results.push(entryPath);
  }
  return results;
}

function normalizedPath(filePath) {
  return path.relative(projectRoot, filePath).replaceAll(path.sep, "/");
}

const errors = [];
try {
  const [packageJson, readme, serviceInfo, allowlist] = await Promise.all([
    readFile(path.join(projectRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "README.md"), "utf8"),
    readFile(path.join(projectRoot, "src", "service-info.ts"), "utf8"),
    readFile(path.join(projectRoot, "scripts", "brand-allowlist.json"), "utf8").then(JSON.parse),
  ]);
  if (packageJson.name !== "toolspan-mcp") errors.push("package.json.name: current package identity must be toolspan-mcp");
  if (!/\bToolSpan\b/u.test(readme)) errors.push("README.md: current ToolSpan identity is missing");
  if (!/product:\s*["']ToolSpan["']/u.test(serviceInfo) || !/service:\s*["']toolspan["']/u.test(serviceInfo)) {
    errors.push("src/service-info.ts: canonical ToolSpan product/service identity is missing");
  }

  const rules = allowlist.entries.map((entry) => ({
    ...entry,
    pathExpression: new RegExp(entry.pathPattern, "u"),
    contentExpression: new RegExp(entry.contentPattern, "iu"),
    used: 0,
  }));
  const files = await walk(projectRoot);
  const occurrences = [];
  for (const file of files) {
    const relativePath = normalizedPath(file);
    if (relativePath === "scripts/brand-allowlist.json") continue;
    if (legacyPattern.test(relativePath)) occurrences.push({ path: relativePath, line: 0, content: "@path" });
    legacyPattern.lastIndex = 0;
    let content;
    try { content = await readFile(file, "utf8"); } catch { continue; }
    for (const [index, line] of content.split(/\r?\n/u).entries()) {
      const matches = line.match(legacyPattern) ?? [];
      for (let count = 0; count < matches.length; count += 1) {
        occurrences.push({ path: relativePath, line: index + 1, content: line });
      }
      legacyPattern.lastIndex = 0;
    }
  }

  const unexpected = [];
  for (const occurrence of occurrences) {
    const rule = rules.find((candidate) => candidate.pathExpression.test(occurrence.path)
      && candidate.contentExpression.test(occurrence.content)
      && candidate.used < candidate.maxOccurrences);
    if (rule === undefined) unexpected.push(`${occurrence.path}:${occurrence.line}`);
    else rule.used += 1;
  }
  if (unexpected.length > 0) errors.push(...unexpected.map((location) => `${location}: non-allowlisted legacy brand reference`));

  process.stdout.write(`${JSON.stringify({
    status: errors.length === 0 ? "PASS" : "FAIL",
    currentIdentity: "ToolSpan",
    legacyReferenceCount: occurrences.length,
    allowlistUsage: Object.fromEntries(rules.filter((rule) => rule.used > 0).map((rule) => [rule.id, rule.used])),
    errors,
  }, null, 2)}\n`);
  if (errors.length > 0) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    status: "FAIL",
    errors: [error instanceof Error ? error.message : "Brand check failed"],
  }, null, 2)}\n`);
  process.exitCode = 1;
}
