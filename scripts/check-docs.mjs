import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = [
  "open_workspace", "list_workspaces", "resume_workspace",
  "read", "write", "edit", "search_files", "list_directory", "stat_path", "make_directory",
  "move_path", "copy_path", "delete_path", "restore_path", "read_many", "apply_patch", "import_asset",
  "start_job", "poll_job", "cancel_job", "list_jobs",
  "start_capture", "inspect_artifact", "list_artifacts", "preview_artifact", "publish_artifact",
  "devspace_info",
];

function assert(condition, message) {
  if (!condition) throw new Error(`docs check: ${message}`);
}

async function text(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

function contractTools(content, relativePath) {
  const start = content.indexOf("<!-- tool-contract:start -->");
  const end = content.indexOf("<!-- tool-contract:end -->");
  assert(start >= 0 && end > start, `${relativePath} must contain one tool-contract block`);
  const block = content.slice(start, end);
  return [...block.matchAll(/`([a-z][a-z0-9_]*)`/gu)].map((match) => match[1]);
}

function requireInOrder(content, earlier, later, relativePath) {
  const earlierIndex = content.indexOf(earlier);
  const laterIndex = content.indexOf(later);
  assert(earlierIndex >= 0, `${relativePath} is missing ${earlier}`);
  assert(laterIndex >= 0, `${relativePath} is missing ${later}`);
  assert(earlierIndex < laterIndex, `${relativePath} must show ${earlier} before ${later}`);
}

async function main() {
  const [english, chinese, usage] = await Promise.all([
    text("README.md"),
    text("README.zh-CN.md"),
    text(path.join("docs", "usage", "chatgpt-chat-vs-codex.md")),
  ]);

  assert(english.startsWith("# ToolSpan\n"), "README.md must be the English ToolSpan README");
  assert(chinese.startsWith("# ToolSpan\n"), "README.zh-CN.md must be a full ToolSpan README");
  for (const heading of [
    "## Local tools and remote tools",
    "## Security warning",
    "## Quick start: deterministic local smoke",
    "## Remote connection overview",
    "## Four common workflows",
    "## Exact 27-tool contract",
    "## ChatGPT Chat, MCP, and Codex usage",
    "## Troubleshooting decision tree",
  ]) assert(english.includes(heading), `README.md is missing ${heading}`);
  for (const heading of [
    "## 本地工具与远程工具",
    "## 安全警告",
    "## 快速开始：确定性本地 Smoke",
    "## 远程连接概览",
    "## 四个常用工作流",
    "## Exact 27 Tool Contract",
    "## ChatGPT Chat、MCP 与 Codex 用量",
    "## Troubleshooting 决策树",
  ]) assert(chinese.includes(heading), `README.zh-CN.md is missing ${heading}`);

  for (const readme of [english, chinese]) {
    assert(readme.includes("Codex") && readme.includes("ToolSpan MCP"), "README must distinguish Codex-local and ToolSpan-remote actions");
    assert(readme.includes("npm.cmd run verify:core"), "README must include the deterministic Core verification command");
    assert(readme.includes("npm.cmd run smoke:core-release"), "README must include the local packed-release smoke");
    assert(readme.includes("devspace_info") && readme.includes("instanceName"), "README must require instance confirmation before writes/jobs");
    assert(readme.includes("shell: false"), "README must preserve the shell:false boundary");
    assert(readme.includes("headless") || readme.includes("无头"), "README must present headless Core as a complete path");
  }
  requireInOrder(english, "## Security warning", "### 2. Modify and test", "README.md");
  requireInOrder(chinese, "## 安全警告", "### 2. 修改并测试", "README.zh-CN.md");

  const expected = [...TOOLS].sort();
  for (const [relativePath, content] of [["README.md", english], ["README.zh-CN.md", chinese]]) {
    const actual = contractTools(content, relativePath).sort();
    assert(actual.length === 27, `${relativePath} tool-contract block must contain 27 tools, found ${actual.length}`);
    assert(actual.every((name, index) => name === expected[index]), `${relativePath} tool-contract block does not match the exact contract`);
  }

  assert(usage.includes("## English") && usage.includes("## 中文"), "usage guide must be bilingual");
  assert(usage.includes("STALE_FALLBACK") && usage.includes("30 days") && usage.includes("30 天"), "usage guide must explain the stale fallback in both languages");
  assert(usage.includes("Ordinary CI never fetches") && usage.includes("普通 CI 不会抓取"), "usage guide must state that ordinary CI is offline");

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    readmes: ["README.md", "README.zh-CN.md"],
    tools: "27/27",
    usageGuide: "PASS",
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "docs check failed"}\n`);
  process.exitCode = 1;
});
