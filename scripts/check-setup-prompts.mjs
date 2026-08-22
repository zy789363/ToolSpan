import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REQUIRED_PROMPTS = [
  "cloudflare-browser.md",
  "cloudflare-terminal.md",
  "chatgpt-browser.md",
  "full-setup.md",
  "troubleshoot-setup.md",
];
export const FILESYSTEM_E2E_PROMPT = "docs/chatgpt-filesystem-e2e-prompt.md";
export const CHECKPOINTS = [
  "AFFILIATE_CHOICE",
  "LOGIN",
  "SECRET_ENTRY",
  "CLOUDFLARE_APPLY",
  "CHATGPT_CREATE_AND_AUTHORIZE",
  "FINAL_VERIFY",
];
const SAFE_MANIFEST_FIELDS = [
  "schemaVersion", "toolSpanVersion", "instanceName", "localUrl", "desiredHostname", "publicMcpUrl",
  "oauthDiscoveryUrl", "expectedToolCount", "tunnelName", "domainChoice", "officialDocs", "generatedAt",
];

function fail(message) {
  throw new Error(`setup prompts check: ${message}`);
}

function checkpointBlock(content, relativePath) {
  const startMarker = "<!-- setup-checkpoints:start -->";
  const endMarker = "<!-- setup-checkpoints:end -->";
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start < 0 || end <= start || content.indexOf(startMarker, start + startMarker.length) >= 0) {
    fail(`${relativePath} must contain exactly one setup-checkpoints block`);
  }
  return content.slice(start + startMarker.length, end);
}

function requirePatterns(content, patterns, relativePath) {
  for (const pattern of patterns) if (!pattern.test(content)) fail(`${relativePath} is missing ${String(pattern)}`);
}

function containsSecretValue(content) {
  const patterns = [
    /Bearer\s+[A-Za-z0-9._~-]{16,}/u,
    /(?:X-Auth-Key|api[_ -]?token|global[_ -]?api[_ -]?key|password|client[_ -]?secret)\s*[:=]\s*["']?(?!\$|<|\[|\{|MASKED|REDACTED)[A-Za-z0-9+/_=-]{16,}/iu,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  ];
  return patterns.some((pattern) => pattern.test(content));
}

function requestsSensitiveEcho(content, sensitivePattern) {
  return content.split(/\r?\n/u).some((line) => {
    if (!/(?:输出|回显|报告|展示|列出)/iu.test(line) || !sensitivePattern.test(line)) return false;
    return !/(?:不(?:得|要|可|应)|禁止|切勿|无需|仅输出|只输出)/iu.test(line);
  });
}

function validateFilesystemE2ePrompt(content) {
  const hardCodedDrivePaths = [...content.matchAll(/\b[A-Za-z]:[\\/]/gu)].length;
  if (hardCodedDrivePaths !== 0) fail(`${FILESYSTEM_E2E_PROMPT} must not hard-code a drive path`);
  requirePatterns(content, [
    /REMOTE_INSTANCE_CONFIRMATION=REQUIRED/u,
    /EXACT_ALLOWED_ROOTS_CONFIRMATION=REQUIRED/u,
    /SYNTHETIC_FIXTURE_ONLY=true/u,
    /DELETE_HUMAN_CONFIRMATION=REQUIRED/u,
    /在任何写入或 `open_workspace` 前.*remote instance.*instanceName.*完全一致/isu,
    /在任何写入或 `open_workspace` 前.*exact allowedRoots.*逐项、顺序和数量完全一致/isu,
    /所有文件系统工具的 `path`、`source`、`destination`.*synthetic fixture/isu,
    /每一次 `delete_path` 或 `apply_patch` 的 `delete_file` 前.*暂停.*人类明确确认/isu,
    /不得输出完整 tool input.*完整 tool result/isu,
    /不得输出.*Secret/isu,
    /不得输出.*workspaceId.*recoveryId/isu,
  ], FILESYSTEM_E2E_PROMPT);
  if (containsSecretValue(content)) fail(`${FILESYSTEM_E2E_PROMPT} appears to contain a Secret value`);

  const fullResultEchoRequested = requestsSensitiveEcho(content, /(?:完整 (?:tool )?(?:input|result)|完整输入|完整返回结果)/iu);
  const secretEchoRequested = requestsSensitiveEcho(content, /(?:Secret|Token|密码|凭证)/iu);
  const identifierEchoRequested = requestsSensitiveEcho(content, /(?:workspaceId|recoveryId)/iu);
  if (fullResultEchoRequested || secretEchoRequested || identifierEchoRequested) {
    fail(`${FILESYSTEM_E2E_PROMPT} requests sensitive or complete-result echo`);
  }
  return {
    gated: true,
    hardCodedDrivePaths,
    remoteInstanceConfirmation: "REQUIRED",
    exactAllowedRootsConfirmation: "REQUIRED",
    syntheticFixtureOnly: true,
    fullResultEchoRequested,
    secretEchoRequested,
    identifierEchoRequested,
    deleteHumanConfirmation: "REQUIRED",
  };
}

export function validatePrompt(content, relativePath) {
  const block = checkpointBlock(content, relativePath);
  const actual = [...block.matchAll(/^\d+\.\s+`([A-Z_]+)`\s+—\s+([^\r\n]+)/gmu)].map((match) => ({
    name: match[1],
    instruction: match[2],
  }));
  if (JSON.stringify(actual.map((entry) => entry.name)) !== JSON.stringify(CHECKPOINTS)) {
    fail(`${relativePath} must declare all six checkpoints exactly once and in order`);
  }
  for (const entry of actual) {
    if (!/PAUSE|NOT_APPLICABLE/iu.test(entry.instruction)) fail(`${relativePath} checkpoint ${entry.name} must PAUSE or explicitly be NOT_APPLICABLE`);
  }
  requirePatterns(content, [
    /Safe Manifest/iu,
    /27/u,
    /不要读取密码管理器、剪贴板历史、DOM secret、截图 secret 或 shell history/iu,
    /不.*Secret.*(?:Prompt|命令行|日志|receipt|诊断)/iu,
  ], relativePath);
  if (containsSecretValue(content)) fail(`${relativePath} appears to contain a Secret value`);
  return actual;
}

function validateSafeManifestSchema(schema) {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) fail("safe manifest schema must be an object");
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema" || schema.type !== "object" || schema.additionalProperties !== false) {
    fail("safe manifest schema must be a closed JSON Schema 2020-12 object");
  }
  const required = [...(schema.required ?? [])].sort();
  const properties = Object.keys(schema.properties ?? {}).sort();
  const expected = [...SAFE_MANIFEST_FIELDS].sort();
  if (JSON.stringify(required) !== JSON.stringify(expected) || JSON.stringify(properties) !== JSON.stringify(expected)) {
    fail("safe manifest schema fields must exactly match the approved non-secret field set");
  }
  if (schema.properties.expectedToolCount?.const !== 27) fail("safe manifest expectedToolCount must be frozen at 27");
}

export async function run() {
  const promptEntries = await Promise.all(REQUIRED_PROMPTS.map(async (name) => {
    const relativePath = path.join("docs", "prompts", name).replaceAll("\\", "/");
    const content = await readFile(path.join(ROOT, ...relativePath.split("/")), "utf8");
    return { name, relativePath, content, checkpoints: validatePrompt(content, relativePath) };
  }));
  const byName = Object.fromEntries(promptEntries.map((entry) => [entry.name, entry.content]));
  requirePatterns(byName["cloudflare-browser.md"], [
    /aiqushi\.top/u,
    /mcp\.aiqushi\.top/u,
    /Zone.*(?:Active|Pending)/isu,
    /Cloudflare assigned nameservers/iu,
    /NameSilo 最终 Save 前暂停/u,
    /不得购买域名、改支付信息或操作其他域名/u,
  ], "docs/prompts/cloudflare-browser.md");
  requirePatterns(byName["cloudflare-terminal.md"], [
    /shell:false/iu,
    /create 不盲目重放/u,
    /不按端口杀进程/u,
    /official cloudflared/iu,
  ], "docs/prompts/cloudflare-terminal.md");
  requirePatterns(byName["chatgpt-browser.md"], [
    /STALE_GUIDE_FALLBACK/u,
    /BLOCKED_BY_HOST_PLAN_OR_POLICY/u,
    /不要要求用户购买 Business/u,
    /expected tool count 27/iu,
    /只有真实 Host evidence/u,
  ], "docs/prompts/chatgpt-browser.md");
  requirePatterns(byName["full-setup.md"], [
    /不要开发 MCP Client、Gateway、Agent Runtime 或 Shell/u,
    /PLANNED 前副作用为 0/u,
    /second run duplicates=0/iu,
    /管理凭证持久化必须为 0/u,
  ], "docs/prompts/full-setup.md");
  requirePatterns(byName["troubleshoot-setup.md"], [
    /默认只读/u,
    /同一无新证据.*不重复完整套件/u,
    /不.*放宽 SSRF\/Host\/Origin\/allowedRoots/u,
    /partial rollback/iu,
  ], "docs/prompts/troubleshoot-setup.md");

  const filesystemE2eContent = await readFile(path.join(ROOT, ...FILESYSTEM_E2E_PROMPT.split("/")), "utf8");
  const filesystemE2eSafety = validateFilesystemE2ePrompt(filesystemE2eContent);

  const schema = JSON.parse(await readFile(path.join(ROOT, "schemas", "setup-safe-manifest.schema.json"), "utf8"));
  validateSafeManifestSchema(schema);
  const result = {
    status: "PASS",
    prompts: REQUIRED_PROMPTS,
    checkpoints: CHECKPOINTS,
    checkpointCountPerPrompt: 6,
    safeManifestFields: SAFE_MANIFEST_FIELDS,
    secretValues: 0,
    browserNameserverFinalSavePause: "PASS",
    filesystemE2eSafety,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "setup prompts check failed"}\n`);
    process.exitCode = 1;
  });
}
