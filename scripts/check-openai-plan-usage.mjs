import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_SNAPSHOT = path.join(PROJECT_ROOT, "config", "openai-plan-usage.snapshot.json");
const DEFAULT_SCHEMA = path.join(PROJECT_ROOT, "config", "openai-plan-usage.schema.json");
const MAX_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE_HOSTS = new Set([
  "chatgpt.com",
  "developers.openai.com",
  "help.openai.com",
  "learn.chatgpt.com",
]);

function fail(message) {
  throw new Error(`openai-plan-usage: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value, location) {
  if (!isRecord(value)) fail(`${location} must be an object`);
  return value;
}

function exactKeys(value, expected, location) {
  const actual = Object.keys(record(value, location)).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${location} keys must be exactly: ${wanted.join(", ")}`);
  }
}

function positiveInteger(value, location) {
  if (!Number.isInteger(value) || value < 1) fail(`${location} must be a positive integer`);
  return value;
}

function boolean(value, location) {
  if (typeof value !== "boolean") fail(`${location} must be a boolean`);
  return value;
}

function nonEmptyString(value, location) {
  if (typeof value !== "string" || value.length === 0) fail(`${location} must be a non-empty string`);
  return value;
}

function range(value, location) {
  if (!Array.isArray(value) || value.length !== 2) fail(`${location} must contain exactly two values`);
  const minimum = positiveInteger(value[0], `${location}[0]`);
  const maximum = positiveInteger(value[1], `${location}[1]`);
  if (minimum > maximum) fail(`${location} minimum cannot exceed maximum`);
  return [minimum, maximum];
}

function utcDate(value, location) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    fail(`${location} must use YYYY-MM-DD`);
  }
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value) {
    fail(`${location} is not a valid calendar date`);
  }
  return milliseconds;
}

function validateSource(value, location) {
  const source = nonEmptyString(value, location);
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    fail(`${location} must be an absolute URL`);
  }
  if (parsed.protocol !== "https:") fail(`${location} must use HTTPS`);
  if (!SOURCE_HOSTS.has(parsed.hostname)) fail(`${location} must use an approved OpenAI source domain`);
  if (parsed.username !== "" || parsed.password !== "") fail(`${location} must not contain credentials`);
  return parsed.href;
}

function validateChatCap(value, location) {
  exactKeys(value, ["instantMessages", "windowHours", "fallback"], location);
  positiveInteger(value.instantMessages, `${location}.instantMessages`);
  positiveInteger(value.windowHours, `${location}.windowHours`);
  nonEmptyString(value.fallback, `${location}.fallback`);
}

function validateChatMultiplier(value, location) {
  exactKeys(value, ["multiplierVsPlus", "exactInstantCapPublished"], location);
  positiveInteger(value.multiplierVsPlus, `${location}.multiplierVsPlus`);
  if (boolean(value.exactInstantCapPublished, `${location}.exactInstantCapPublished`) !== false) {
    fail(`${location}.exactInstantCapPublished must remain false unless the snapshot schema is revised`);
  }
}

function validateModelRanges(value, location) {
  exactKeys(value, ["sol", "terra", "luna"], location);
  return {
    sol: range(value.sol, `${location}.sol`),
    terra: range(value.terra, `${location}.terra`),
    luna: range(value.luna, `${location}.luna`),
  };
}

function equalRange(left, right) {
  return left[0] === right[0] && left[1] === right[1];
}

function multipliedRange(base, multiplier) {
  return [base[0] * multiplier, base[1] * multiplier];
}

export function validateSnapshot(snapshot) {
  exactKeys(snapshot, [
    "schemaVersion",
    "verifiedAt",
    "verificationStatus",
    "verificationGaps",
    "absoluteConversionPublished",
    "sources",
    "chat",
    "codexLocalMessagesPer5h",
    "flexibleCredits",
    "mcpAvailability",
  ], "snapshot");

  if (snapshot.schemaVersion !== 2) fail("snapshot.schemaVersion must be 2");
  const verifiedAtMs = utcDate(snapshot.verifiedAt, "snapshot.verifiedAt");
  const verificationStatuses = new Set([
    "OFFICIAL_SOURCES_VERIFIED",
    "INCOMPLETE_OFFICIAL_COVERAGE",
  ]);
  if (!verificationStatuses.has(snapshot.verificationStatus)) {
    fail("snapshot.verificationStatus is invalid");
  }
  if (!Array.isArray(snapshot.verificationGaps)
    || new Set(snapshot.verificationGaps).size !== snapshot.verificationGaps.length
    || snapshot.verificationGaps.some((gap) => typeof gap !== "string" || !/^[A-Z0-9_]+$/u.test(gap))) {
    fail("snapshot.verificationGaps must be unique stable codes");
  }
  if (snapshot.verificationStatus === "OFFICIAL_SOURCES_VERIFIED" && snapshot.verificationGaps.length !== 0) {
    fail("a fully verified snapshot cannot retain verification gaps");
  }
  if (snapshot.verificationStatus === "INCOMPLETE_OFFICIAL_COVERAGE" && snapshot.verificationGaps.length === 0) {
    fail("incomplete official coverage requires at least one verification gap");
  }
  if (boolean(snapshot.absoluteConversionPublished, "snapshot.absoluteConversionPublished") !== false) {
    fail("absolute chat-to-Codex conversion claims are not allowed");
  }

  const sourceKeys = [
    "chatPricing",
    "gpt55Limits",
    "gpt56Limits",
    "codexPricing",
    "codexRateCard",
    "businessChatRateCard",
    "mcpAvailability",
  ];
  exactKeys(snapshot.sources, sourceKeys, "snapshot.sources");
  for (const key of sourceKeys) validateSource(snapshot.sources[key], `snapshot.sources.${key}`);

  exactKeys(snapshot.chat, ["go", "plus", "pro5x", "pro20x", "business"], "snapshot.chat");
  validateChatCap(snapshot.chat.go, "snapshot.chat.go");
  validateChatCap(snapshot.chat.plus, "snapshot.chat.plus");
  validateChatMultiplier(snapshot.chat.pro5x, "snapshot.chat.pro5x");
  validateChatMultiplier(snapshot.chat.pro20x, "snapshot.chat.pro20x");
  exactKeys(snapshot.chat.business, ["instant"], "snapshot.chat.business");
  if (snapshot.chat.business.instant !== "unlimited-subject-to-guardrails") {
    fail("snapshot.chat.business.instant must preserve the guardrails qualifier");
  }

  exactKeys(
    snapshot.codexLocalMessagesPer5h,
    ["plus", "pro5x", "pro20x", "business"],
    "snapshot.codexLocalMessagesPer5h",
  );
  const plus = validateModelRanges(snapshot.codexLocalMessagesPer5h.plus, "snapshot.codexLocalMessagesPer5h.plus");
  const pro5x = validateModelRanges(snapshot.codexLocalMessagesPer5h.pro5x, "snapshot.codexLocalMessagesPer5h.pro5x");
  const pro20x = validateModelRanges(snapshot.codexLocalMessagesPer5h.pro20x, "snapshot.codexLocalMessagesPer5h.pro20x");
  const business = validateModelRanges(snapshot.codexLocalMessagesPer5h.business, "snapshot.codexLocalMessagesPer5h.business");
  for (const model of ["sol", "terra", "luna"]) {
    if (!equalRange(pro5x[model], multipliedRange(plus[model], snapshot.chat.pro5x.multiplierVsPlus))) {
      fail(`snapshot.codexLocalMessagesPer5h.pro5x.${model} does not match its declared multiplier`);
    }
    if (!equalRange(pro20x[model], multipliedRange(plus[model], snapshot.chat.pro20x.multiplierVsPlus))) {
      fail(`snapshot.codexLocalMessagesPer5h.pro20x.${model} does not match its declared multiplier`);
    }
    if (!equalRange(business[model], plus[model])) {
      fail(`snapshot.codexLocalMessagesPer5h.business.${model} must match the baseline range`);
    }
  }

  exactKeys(snapshot.flexibleCredits, ["gpt56AverageCreditsPerMessage"], "snapshot.flexibleCredits");
  range(snapshot.flexibleCredits.gpt56AverageCreditsPerMessage, "snapshot.flexibleCredits.gpt56AverageCreditsPerMessage");

  exactKeys(snapshot.mcpAvailability, ["plus", "pro", "business", "enterpriseEdu"], "snapshot.mcpAvailability");
  const allowedMcpStates = new Set(["not-full-custom-mcp", "read-fetch-only", "full-write-modify-beta"]);
  for (const [plan, state] of Object.entries(snapshot.mcpAvailability)) {
    if (!allowedMcpStates.has(state)) fail(`snapshot.mcpAvailability.${plan} has an unsupported state`);
  }

  return { verifiedAtMs, sourceKeys, verificationStatus: snapshot.verificationStatus };
}

export function freshness(snapshot, now = new Date()) {
  const { verifiedAtMs, verificationStatus } = validateSnapshot(snapshot);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail("now must be a valid date");
  const ageMs = now.getTime() - verifiedAtMs;
  if (ageMs < -DAY_MS) fail("snapshot.verifiedAt cannot be more than one day in the future");
  const ageDays = Math.max(0, Math.floor(ageMs / DAY_MS));
  if (verificationStatus !== "OFFICIAL_SOURCES_VERIFIED") {
    return {
      ageDays,
      maxAgeDays: MAX_AGE_DAYS,
      status: "STALE_FALLBACK",
      fallbackReason: "OFFICIAL_SOURCE_COVERAGE_INCOMPLETE",
    };
  }
  const stale = ageMs > MAX_AGE_DAYS * DAY_MS;
  return {
    ageDays,
    maxAgeDays: MAX_AGE_DAYS,
    status: stale ? "STALE_FALLBACK" : "CURRENT",
    fallbackReason: stale ? "SNAPSHOT_OLDER_THAN_30_DAYS" : null,
  };
}

function label(language, english, chinese) {
  return language === "zh" ? chinese : english;
}

function displayRange(value) {
  return `${value[0]}–${value[1]}`;
}

export function renderUsageMarkdown(snapshot, now = new Date(), language = "en") {
  if (!new Set(["en", "zh"]).has(language)) fail("render language must be en or zh");
  const state = freshness(snapshot, now);
  const fallback = label(language, "See current official limits", "查看当前官方限制");
  const lines = [
    `**${label(language, "Snapshot status", "快照状态")}: ${state.status}**`,
    "",
  ];
  if (state.status === "STALE_FALLBACK") {
    lines.push(
      state.fallbackReason === "OFFICIAL_SOURCE_COVERAGE_INCOMPLETE"
        ? `> ${label(language, "The snapshot could not be fully verified from current official sources. Specific quantities are hidden; use the official links.", "当前官方来源无法完整验证此快照。具体数字已隐藏；请查看官方链接。")}`
        : `> ${label(language, "The snapshot is older than 30 days. Specific quantities are hidden; use the official links.", "快照已超过 30 天。具体数字已隐藏；请查看官方链接。")}`,
      "",
    );
  }

  lines.push(
    `| ${label(language, "Surface", "使用界面")} | ${label(language, "Plan key", "套餐键")} | ${label(language, "Snapshot view", "快照视图")} |`,
    "| --- | --- | --- |",
  );
  for (const plan of ["go", "plus", "pro5x", "pro20x", "business"]) {
    let view = fallback;
    if (state.status === "CURRENT") {
      const chat = snapshot.chat[plan];
      if ("instantMessages" in chat) {
        view = `${chat.instantMessages} / ${chat.windowHours}h; ${label(language, "fallback", "回退")} ${chat.fallback}`;
      } else if ("multiplierVsPlus" in chat) {
        view = `${chat.multiplierVsPlus}× Plus; ${label(language, "exact cap not published", "未公布精确上限")}`;
      } else {
        view = label(language, "Unlimited subject to guardrails", "无限使用受防滥用规则约束");
      }
    }
    lines.push(`| ChatGPT Chat | \`${plan}\` | ${view} |`);
  }
  for (const plan of ["plus", "pro5x", "pro20x", "business"]) {
    const ranges = snapshot.codexLocalMessagesPer5h[plan];
    const view = state.status === "CURRENT"
      ? `sol ${displayRange(ranges.sol)}; terra ${displayRange(ranges.terra)}; luna ${displayRange(ranges.luna)}`
      : fallback;
    lines.push(`| Codex | \`${plan}\` | ${view} |`);
  }
  for (const plan of ["plus", "pro", "business", "enterpriseEdu"]) {
    const view = state.status === "CURRENT" ? snapshot.mcpAvailability[plan] : fallback;
    lines.push(`| MCP | \`${plan}\` | ${view} |`);
  }
  return `${lines.join("\n")}\n`;
}

async function parseJsonFile(filePath, labelText) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    fail(`cannot read ${labelText}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  try {
    return JSON.parse(source);
  } catch {
    fail(`${labelText} is not valid JSON`);
  }
}

async function validateSchemaDescriptor(schema) {
  exactKeys(schema, ["$schema", "$id", "title", "type", "additionalProperties", "required", "properties", "$defs"], "schema");
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") fail("schema must use JSON Schema 2020-12");
  if (schema.type !== "object" || schema.additionalProperties !== false) fail("schema root must be a closed object");
  if (schema.properties?.schemaVersion?.const !== 2) fail("schema must freeze schemaVersion 2");
  if (schema.properties?.absoluteConversionPublished?.const !== false) {
    fail("schema must prohibit absolute conversion claims");
  }
}

async function validateDocs() {
  const readme = await readFile(path.join(PROJECT_ROOT, "README.md"), "utf8");
  const forbiddenClaims = [
    /0\s*token\s*unlimited/iu,
    /plus\s+(?:has|includes|supports)\s+full\s+(?:write|modify)/iu,
  ];
  if (forbiddenClaims.some((pattern) => pattern.test(readme))) {
    fail("README.md contains a prohibited usage claim");
  }
}

function parseArguments(arguments_) {
  const options = {
    snapshotPath: DEFAULT_SNAPSHOT,
    schemaPath: DEFAULT_SCHEMA,
    now: new Date(),
    json: false,
    render: undefined,
    skipDocs: false,
  };
  for (const argument of arguments_) {
    if (argument === "--json") options.json = true;
    else if (argument === "--skip-docs") options.skipDocs = true;
    else if (argument.startsWith("--snapshot=")) options.snapshotPath = path.resolve(argument.slice("--snapshot=".length));
    else if (argument.startsWith("--schema=")) options.schemaPath = path.resolve(argument.slice("--schema=".length));
    else if (argument.startsWith("--now=")) options.now = new Date(`${argument.slice("--now=".length)}T00:00:00.000Z`);
    else if (argument.startsWith("--render=")) options.render = argument.slice("--render=".length);
    else fail(`unknown argument: ${argument}`);
  }
  if (options.json && options.render !== undefined) fail("--json and --render cannot be combined");
  return options;
}

export async function run(arguments_ = process.argv.slice(2)) {
  const options = parseArguments(arguments_);
  const [snapshot, schema] = await Promise.all([
    parseJsonFile(options.snapshotPath, "snapshot"),
    parseJsonFile(options.schemaPath, "schema"),
  ]);
  await validateSchemaDescriptor(schema);
  const state = freshness(snapshot, options.now);
  if (!options.skipDocs) await validateDocs();

  if (options.render !== undefined) {
    process.stdout.write(renderUsageMarkdown(snapshot, options.now, options.render));
    return;
  }
  const result = {
    status: "PASS",
    snapshotStatus: state.status,
    fallbackReason: state.fallbackReason,
    verifiedAt: snapshot.verifiedAt,
    ageDays: state.ageDays,
    maxAgeDays: state.maxAgeDays,
    networkRequests: 0,
    docs: options.skipDocs ? "SKIPPED" : "PASS",
  };
  process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : [
    `OpenAI usage snapshot: ${result.snapshotStatus}`,
    `fallbackReason: ${result.fallbackReason ?? "NONE"}`,
    `verifiedAt: ${result.verifiedAt} (${result.ageDays} day(s) old; max ${result.maxAgeDays})`,
    `schema/calculations/sources/docs: PASS`,
    "network requests: 0",
  ].join("\n") + "\n");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "openai-plan-usage check failed"}\n`);
    process.exitCode = 1;
  });
}
