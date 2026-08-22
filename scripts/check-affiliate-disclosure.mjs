import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCommercialLinks, validateOfferSnapshot } from "./check-commercial-links.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(`affiliate disclosure check: ${message}`);
}

async function json(relativePath) {
  try {
    return JSON.parse(await readFile(path.join(ROOT, relativePath), "utf8"));
  } catch (error) {
    fail(`cannot parse ${relativePath}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function block(content, name) {
  const startMarker = `<!-- ${name}:start -->`;
  const endMarker = `<!-- ${name}:end -->`;
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start < 0 || end <= start || content.indexOf(startMarker, start + startMarker.length) >= 0) {
    fail(`document must contain exactly one valid ${name} block`);
  }
  return content.slice(start + startMarker.length, end);
}

function includesAll(content, patterns, location) {
  for (const pattern of patterns) if (!pattern.test(content)) fail(`${location} is missing ${String(pattern)}`);
}

export function validateAffiliateDocument(content, links, offer) {
  const pathsBlock = block(content, "domain-paths");
  const choices = pathsBlock.split(/\r?\n/u).map((line) => line.trim()).filter((line) => /^\d+\.\s/u.test(line));
  const expectedChoices = [
    "1. I already have a domain",
    "2. Use any registrar",
    "3. NameSilo — Support ToolSpan",
    "4. NameSilo — No referral",
  ];
  if (JSON.stringify(choices) !== JSON.stringify(expectedChoices)) fail("four domain paths must appear in the specified order");
  if (choices.some((choice) => /\*\*|\[|推荐|recommended|best|★|🔥/iu.test(choice))) {
    fail("domain choices must use equal plain-text visual weight without badges or preselection");
  }

  const referral = block(content, "namesilo-disclosure");
  const direct = block(content, "namesilo-direct");
  const fallback = block(content, "vendor-fallback");
  includesAll(referral, [
    /项目可能获得佣金/u,
    /Affiliate-only Coupon/u,
    /attribution/iu,
    /续费/u,
    /premium domain/iu,
    /税费/u,
    /结账/u,
    /Discount Program/u,
  ], "adjacent referral disclosure");
  if (!referral.includes(`\`${offer.affiliateCouponCode}\``)) fail("referral disclosure must identify the coupon code");
  for (const [name, pair] of Object.entries(links.links)) {
    if (!referral.includes(pair.referral)) fail(`referral disclosure is missing the ${name} referral URL`);
    if (!direct.includes(pair.direct)) fail(`no-referral block is missing the ${name} direct URL`);
  }
  if (/(?:[?&]rid=|toolspan)/iu.test(direct)) fail("no-referral block must contain neither rid nor coupon");
  if (!/不带 `rid`/u.test(direct) || !/不显示、复制或使用 affiliate coupon/iu.test(direct)) {
    fail("no-referral block must explicitly reject attribution and coupon use");
  }

  includesAll(content, [
    /相同组件、字号、按钮尺寸、颜色层级和可点击面积/u,
    /不预选/u,
    /核心 Setup、Cloudflare、27 tools 与支持质量不依赖任何选择/u,
    /不自动打开链接/u,
    /复制 coupon/iu,
    /点击遥测/u,
    /超过 30 天自动隐藏所有具体价格、折扣、合计数字和 coupon CTA/u,
    /不能只换一个“可能过期”标签却继续展示数字/u,
  ], "commercial disclosure document");
  if (/\$\s*\d|USD\s*\d/iu.test(content)) fail("static docs must not hard-code offer numbers that outlive the snapshot renderer");
  if (!fallback.includes("TEXT_ONLY_FALLBACK") || !fallback.includes("FALLBACK_PASS")) {
    fail("vendor fallback block must explicitly define TEXT_ONLY_FALLBACK/FALLBACK_PASS");
  }
  return { choices, referral, direct };
}

export async function run() {
  const [content, linksValue, offerValue] = await Promise.all([
    readFile(path.join(ROOT, "docs", "setup", "domains-and-namesilo.md"), "utf8"),
    json("config/commercial-links.json"),
    json("config/namesilo-offer.snapshot.json"),
  ]);
  const links = validateCommercialLinks(linksValue);
  const offer = validateOfferSnapshot(offerValue, links);
  const evidence = validateAffiliateDocument(content, links, offer);
  const result = {
    status: "PASS",
    domainPaths: evidence.choices.length,
    equalVisualWeight: "PASS",
    adjacentCommissionDisclosure: "PASS",
    couponAttributionDisclosure: "PASS",
    noReferralRidCount: 0,
    noReferralCouponUse: false,
    staleFallback: "PASS",
    clickTelemetry: 0,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "affiliate disclosure check failed"}\n`);
    process.exitCode = 1;
  });
}
