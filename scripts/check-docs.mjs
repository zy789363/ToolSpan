import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_HEADINGS = [
  "## 为什么使用 ToolSpan",
  "## 工作方式",
  "## 快速开始",
  "## 开始第一个编程任务",
  "## 安全边界",
  "## 常见问题",
  "## 更多文档",
];

function assert(condition, message) {
  if (!condition) throw new Error(`docs check: ${message}`);
}

function requireInOrder(content, values) {
  let cursor = -1;
  for (const value of values) {
    const index = content.indexOf(value);
    assert(index > cursor, `README.md is missing or misorders ${value}`);
    cursor = index;
  }
}

async function main() {
  const readme = await readFile(path.join(ROOT, "README.md"), "utf8");
  const lineCount = readme.trimEnd().split(/\r?\n/u).length;

  assert(readme.includes('<h1 align="center">ToolSpan</h1>'), "README.md must have the centered ToolSpan hero");
  assert(readme.includes('src="apps/desktop/src-tauri/icons/app-icon.png"'), "README.md must show the product icon");
  assert(readme.includes("github.com/zy789363/ToolSpan/releases/latest"), "README.md must expose the primary download action");
  assert(readme.includes("actions/workflows/core.yml/badge.svg"), "README.md must show Core CI status");
  assert(lineCount <= 140, `README.md must remain scannable, found ${lineCount} lines`);
  requireInOrder(readme, REQUIRED_HEADINGS);

  for (const required of [
    "GUI 优先",
    "MCP 工具 `27/27`",
    "设置 → 运行时 → 选择 Node 可执行文件",
    "Scoped API Token",
    "验证凭证并运行 Preflight",
    "生成 Dry Run",
    "为 Apply 重新输入凭证",
    "Apply 已确认计划",
    "Host 接入教程",
    "Settings → Security and login",
    "Developer mode",
    "https://developers.openai.com/plugins/deploy/connect-chatgpt",
    "devspace_info",
    "[设置文档索引](docs/setup/index.md)",
    "[非 GUI 配置与部署](docs/deployment.md)",
  ]) {
    assert(readme.includes(required), `README.md is missing ${required}`);
  }

  for (const forbidden of ["```powershell", "npm.cmd", "toolspan.config.json", "ownerPasswordHashFile", "publicBaseUrl", "Invoke-RestMethod", "New-Item"]) {
    assert(!readme.includes(forbidden), `README.md must link to non-GUI setup instead of embedding ${forbidden}`);
  }

  await access(path.join(ROOT, "apps", "desktop", "src-tauri", "icons", "app-icon.png"));
  const localLinks = [...readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)]
    .map((match) => match[1])
    .filter((target) => !/^https?:\/\//u.test(target) && !target.startsWith("#"));
  for (const target of localLinks) {
    try {
      await access(path.resolve(ROOT, target));
    } catch {
      assert(false, `README.md contains a missing local link: ${target}`);
    }
  }

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    readme: "README.md",
    primaryPath: "GUI",
    sections: REQUIRED_HEADINGS.length,
    lines: lineCount,
    localLinks: localLinks.length,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "docs check failed"}\n`);
  process.exitCode = 1;
});
