import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateChatgptSnapshot,
  validateCloudflareSnapshot,
  validateCommercialLinks,
  validateOfferSnapshot,
} from "./check-commercial-links.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REQUIRED_SETUP_DOCS = [
  "index.md",
  "cloudflare-manual.md",
  "cloudflare-zone-onboarding.md",
  "cloudflare-scoped-token.md",
  "cloudflared-runtime-credential.md",
  "chatgpt-custom-mcp.md",
  "domains-and-namesilo.md",
  "agent-assisted.md",
  "troubleshooting-and-rollback.md",
];

function fail(message) {
  throw new Error(`setup docs check: ${message}`);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function json(relativePath) {
  try {
    return JSON.parse(await readFile(path.join(ROOT, ...relativePath.split("/")), "utf8"));
  } catch (error) {
    fail(`cannot parse ${relativePath}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function requirePatterns(content, patterns, relativePath) {
  for (const pattern of patterns) if (!pattern.test(content)) fail(`${relativePath} is missing ${String(pattern)}`);
}

function requireOrder(content, values, relativePath) {
  let cursor = -1;
  for (const value of values) {
    const next = content.indexOf(value, cursor + 1);
    if (next < 0) fail(`${relativePath} is missing ordered item: ${value}`);
    if (next <= cursor) fail(`${relativePath} must place ${value} after the preceding item`);
    cursor = next;
  }
}

function secretValueMatches(content) {
  return [
    /Bearer\s+[A-Za-z0-9._~-]{16,}/u,
    /(?:X-Auth-Key|api[_ -]?token|global[_ -]?api[_ -]?key|password|client[_ -]?secret)\s*[:=]\s*["']?(?!\$|<|\[|\{|MASKED|REDACTED)[A-Za-z0-9+/_=-]{16,}/iu,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  ].filter((pattern) => pattern.test(content));
}

function validateManual(content) {
  const headings = [...content.matchAll(/^## (\d+)\. ([^\r\n]+)/gmu)];
  const expectedTitles = [
    "Local health",
    "Domain / Zone",
    "Create or select Tunnel",
    "Route hostname to local Core",
    "DNS",
    "Install / run cloudflared",
    "Public health",
    "OAuth metadata",
    "Host scan and exact 27 tools",
  ];
  if (headings.length !== expectedTitles.length) fail("cloudflare-manual.md must contain exactly nine numbered tutorial steps");
  for (const [index, match] of headings.entries()) {
    if (Number(match[1]) !== index + 1 || match[2] !== expectedTitles[index]) fail(`cloudflare-manual.md step ${index + 1} title/order is invalid`);
    const start = match.index;
    const end = index + 1 < headings.length ? headings[index + 1].index : content.length;
    const section = content.slice(start, end);
    for (const label of ["目的", "操作", "预期结果", "失败分支", "回滚/恢复"]) {
      if (!section.includes(`**${label}：**`)) fail(`cloudflare-manual.md step ${index + 1} is missing ${label}`);
    }
  }
  requireOrder(content, [
    "Local health", "Domain / Zone", "Create or select Tunnel", "Route hostname to local Core", "DNS",
    "Install / run cloudflared", "Public health", "OAuth metadata", "Host scan and exact 27 tools",
  ], "docs/setup/cloudflare-manual.md");
  requirePatterns(content, [
    /\/healthz/u,
    /status 为 `Active`/u,
    /http:\/\/127\.0\.0\.1:<port>/u,
    /catch-all/iu,
    /cloudflared.*credential\/service storage/isu,
    /HTTPS→HTTP 降级/u,
    /\.well-known\/oauth-protected-resource/u,
    /\.well-known\/oauth-authorization-server/u,
    /工具总数恰好 27/u,
    /BLOCKED_BY_HOST_PLAN_OR_POLICY/u,
  ], "docs/setup/cloudflare-manual.md");
}

async function validateInternalLinks(entries) {
  for (const entry of entries) {
    for (const match of entry.content.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const target = match[1];
      if (/^(?:https?:|#)/u.test(target)) continue;
      const fileTarget = target.split("#", 1)[0];
      const absolute = path.resolve(path.dirname(entry.absolutePath), fileTarget);
      if (!absolute.startsWith(path.join(ROOT, "docs") + path.sep) || !await exists(absolute)) {
        fail(`${entry.relativePath} contains a missing/unsafe internal link: ${target}`);
      }
    }
  }
}

export async function run() {
  const entries = await Promise.all(REQUIRED_SETUP_DOCS.map(async (name) => {
    const relativePath = `docs/setup/${name}`;
    const absolutePath = path.join(ROOT, "docs", "setup", name);
    return { name, relativePath, absolutePath, content: await readFile(absolutePath, "utf8") };
  }));
  const docs = Object.fromEntries(entries.map((entry) => [entry.name, entry.content]));
  validateManual(docs["cloudflare-manual.md"]);

  requirePatterns(docs["index.md"], [
    /Guided Manual/u, /Scoped API Token/u, /Agent-assisted/u,
    /不是 MCP Client、Gateway、Agent Runtime 或 Shell/u,
    /PLANNED.*外部副作用.*0/isu,
    /管理 Token 不进 config、DB、journal、日志、Prompt、receipt、诊断/u,
  ], "docs/setup/index.md");
  requirePatterns(docs["cloudflare-zone-onboarding.md"], [
    /aiqushi\.top/u,
    /mcp\.aiqushi\.top/u,
    /Pending Nameserver Update/u,
    /STOP_APPLY/u,
    /Cloudflare assigned nameservers/iu,
    /只操作 `aiqushi\.top`/u,
    /NameSilo 最终 `Save` \/ `Submit` 按钮前.*暂停/isu,
    /不得接收 NameSilo API credential/u,
    /不.*购买.*不修改付款/u,
    /只有.*实际返回 `Active` 后/u,
  ], "docs/setup/cloudflare-zone-onboarding.md");
  requirePatterns(docs["cloudflare-scoped-token.md"], [
    /masked field/iu,
    /没有 Remember/u,
    /PLANNED|Dry Run/u,
    /Zone.*Pending.*STOP_APPLY/isu,
    /第二次运行必须 duplicates = 0/u,
    /NEEDS_CREDENTIAL_REENTRY/u,
  ], "docs/setup/cloudflare-scoped-token.md");
  requirePatterns(docs["cloudflared-runtime-credential.md"], [
    /管理凭证和 Tunnel 运行凭证不是一回事/u,
    /官方 `cloudflared` service \/ credential storage/u,
    /轮换步骤/u,
    /rotate or revoke/iu,
    /旧凭证已撤销/u,
    /卸载 ToolSpan 不擅自删除外部 Tunnel、DNS/u,
    /support bundle 必须排除 service 命令行、注册表 credential/u,
  ], "docs/setup/cloudflared-runtime-credential.md");
  requirePatterns(docs["chatgpt-custom-mcp.md"], [
    /Custom MCP App/u,
    /Settings → Security and login → Developer mode/u,
    /超过 30 天.*隐藏.*UI path/isu,
    /Copy App Name/u,
    /Copy Public MCP URL/u,
    /Copy OAuth discovery URL/u,
    /Copy expected tool count/u,
    /Copy read-only verification prompt/u,
    /Copy write verification prompt/u,
    /Open current official guide\/settings/u,
    /不要要求购买 ChatGPT Business/u,
    /BLOCKED_BY_HOST_PLAN_OR_POLICY/u,
    /点击“完成”只能进入 `USER_CONFIRMED`/u,
  ], "docs/setup/chatgpt-custom-mcp.md");
  requirePatterns(docs["domains-and-namesilo.md"], [
    /I already have a domain/u, /Use any registrar/u,
    /NameSilo — No referral/u,
    /referral\/推广路径已移除|不展示任何 referral\/推广路径|无 referral 路径/u,
    /不带 `rid`/u,
    /超过 30 天自动隐藏所有具体价格、折扣、合计数字和 coupon CTA/u,
    /TEXT_ONLY_FALLBACK/u, /FALLBACK_PASS/u,
  ], "docs/setup/domains-and-namesilo.md");
  requirePatterns(docs["agent-assisted.md"], [
    /schemaVersion/u, /toolSpanVersion/u, /instanceName/u, /localUrl/u,
    /desiredHostname/u, /publicMcpUrl/u, /oauthDiscoveryUrl/u, /expectedToolCount/u,
    /tunnelName/u, /domainChoice/u, /officialDocs/u, /generatedAt/u,
    /AFFILIATE_CHOICE/u, /LOGIN/u, /SECRET_ENTRY/u, /CLOUDFLARE_APPLY/u,
    /CHATGPT_CREATE_AND_AUTHORIZE/u, /FINAL_VERIFY/u,
    /不购买域名、不改支付、不操作其他域名/u,
  ], "docs/setup/agent-assisted.md");
  requirePatterns(docs["troubleshooting-and-rollback.md"], [
    /NEEDS_RECONCILIATION/u,
    /NEEDS_CREDENTIAL_REENTRY/u,
    /created.*才可自动删除/isu,
    /`reused` 永不自动删除/u,
    /fingerprint/u,
    /ROLLBACK_PARTIAL/u,
    /第二次 `duplicates = 0`/u,
  ], "docs/setup/troubleshooting-and-rollback.md");

  await validateInternalLinks(entries);
  for (const entry of entries) {
    const matches = secretValueMatches(entry.content);
    if (matches.length > 0) fail(`${entry.relativePath} appears to contain a Secret value`);
  }

  const [linksValue, offerValue, chatgptValue, cloudflareValue] = await Promise.all([
    json("config/commercial-links.json"),
    json("config/namesilo-offer.snapshot.json"),
    json("config/chatgpt-mcp-guide.snapshot.json"),
    json("config/cloudflare-api-docs.snapshot.json"),
  ]);
  const links = validateCommercialLinks(linksValue);
  validateOfferSnapshot(offerValue, links);
  const chatgpt = validateChatgptSnapshot(chatgptValue);
  const cloudflare = validateCloudflareSnapshot(cloudflareValue);
  if (!docs["chatgpt-custom-mcp.md"].includes(chatgpt.source)) {
    fail("ChatGPT guide must link the dated official source");
  }
  if (!docs["cloudflare-zone-onboarding.md"].includes("config/cloudflare-api-docs.snapshot.json")) {
    fail("Zone guide must identify the dated Cloudflare docs snapshot");
  }
  if (cloudflare.permissionLabelsAreReleaseAssertion !== false) fail("Cloudflare docs snapshot cannot assert Release currentness");

  const result = {
    status: "PASS",
    documents: REQUIRED_SETUP_DOCS,
    guidedManualSteps: 9,
    zoneMissingPendingGate: "STOP_APPLY",
    nameserverFinalSaveHumanCheckpoint: "PASS",
    cloudflaredRotationAndRevocation: "PASS",
    chatgptTruthfulStatuses: 4,
    managementCredentialValues: 0,
    networkRequests: 0,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "setup docs check failed"}\n`);
    process.exitCode = 1;
  });
}
