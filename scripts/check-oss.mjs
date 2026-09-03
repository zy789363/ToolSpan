import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED = [
  "LICENSE",
  "SECURITY.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/pull_request_template.md",
  ".github/dependabot.yml",
];

function assert(condition, message) {
  if (!condition) throw new Error(`OSS check: ${message}`);
}

async function main() {
  const contents = new Map();
  for (const relativePath of REQUIRED) {
    let content;
    try {
      content = await readFile(path.join(ROOT, ...relativePath.split("/")), "utf8");
    } catch {
      throw new Error(`OSS check: missing ${relativePath}`);
    }
    assert(content.trim().length > 0, `${relativePath} must not be empty`);
    contents.set(relativePath, content);
  }

  const license = contents.get("LICENSE");
  const normalizedLicense = license.replaceAll("\r\n", "\n").trimEnd();
  const licenseSha256 = createHash("sha256").update(normalizedLicense, "utf8").digest("hex");
  assert(
    licenseSha256 === "58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd",
    "LICENSE must contain the complete official Apache License 2.0 text",
  );

  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(path.join(ROOT, "package-lock.json"), "utf8"));
  const shrinkwrap = JSON.parse(await readFile(path.join(ROOT, "npm-shrinkwrap.json"), "utf8"));
  assert(packageJson.license === "Apache-2.0", "package.json license must be Apache-2.0");
  assert(packageLock.packages?.[""]?.license === "Apache-2.0", "package-lock.json root license must be Apache-2.0");
  assert(shrinkwrap.packages?.[""]?.license === "Apache-2.0", "npm-shrinkwrap.json root license must be Apache-2.0");

  assert(contents.get("SECURITY.md").includes("OWNER GATE"), "SECURITY.md must expose missing owner contact/identity");
  assert(contents.get("SECURITY.md").includes("不要创建公开 issue"), "SECURITY.md must direct vulnerability reports away from public issues");

  const joined = [...contents.values()].join("\n");
  assert(!/https?:\/\/(?:github\.com\/)?(?:example|your[-_ ]?(?:org|repo|name))/iu.test(joined), "OSS files contain a fabricated placeholder repository URL");
  assert(!/[A-Z0-9._%+-]+@(?:example|invalid)\.[A-Z]{2,}/iu.test(joined), "OSS files contain a fabricated contact email");
  assert(!/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/iu.test(joined), "OSS files must not invent a repository URL");

  const dependabot = contents.get(".github/dependabot.yml");
  assert(dependabot.startsWith("version: 2\n"), "dependabot config must use version 2");
  assert(dependabot.includes("package-ecosystem: npm") && dependabot.includes("package-ecosystem: github-actions"), "dependabot must cover npm and GitHub Actions");

  process.stdout.write(`${JSON.stringify({
    status: "PASS_WITH_OWNER_GATE",
    files: REQUIRED.length,
    license: "Apache-2.0",
    licenseTextSha256: licenseSha256,
    ownerGates: ["PUBLIC_REPOSITORY_URL", "MAINTAINER_SECURITY_CONTACT", "SPONSOR_IDENTITY"],
    blockingClassification: "BLOCKED_BY_OWNER_INPUT",
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "OSS check failed"}\n`);
  process.exitCode = 1;
});
