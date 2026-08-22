import chatGptGuide from "../../../../config/chatgpt-mcp-guide.snapshot.json";
import cloudflareDocs from "../../../../config/cloudflare-api-docs.snapshot.json";
import commercialLinks from "../../../../config/commercial-links.json";
import namesiloOffer from "../../../../config/namesilo-offer.snapshot.json";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CommercialSetupContent {
  current: boolean;
  example: string | null;
  coupon: string | null;
  referralUrl: string;
  directUrl: string;
}

export interface GuideSetupContent {
  current: boolean;
  sourceUrl: string;
  connectionUrl: string | null;
  developerModePath: string[];
  expectedToolCount: 27;
  fallbackText: string;
}

export function snapshotIsCurrent(verifiedAt: string, staleAfterDays: number, now = new Date()): boolean {
  const verified = new Date(`${verifiedAt}T00:00:00.000Z`).getTime();
  const age = now.getTime() - verified;
  return Number.isFinite(verified) && age >= 0 && age <= staleAfterDays * DAY_MS;
}

export function commercialSetupContent(now = new Date()): CommercialSetupContent {
  const current = namesiloOffer.verificationStatus === "OFFICIAL_SOURCES_VERIFIED"
    && namesiloOffer.verificationGaps.length === 0
    && snapshotIsCurrent(namesiloOffer.verifiedAt, namesiloOffer.staleAfterDays, now);
  return {
    current,
    example: current
      ? `.${namesiloOffer.exampleTld} first year $${namesiloOffer.firstYearRegistrationUsd.toFixed(2)}; illustrative eligible subtotal $${namesiloOffer.illustrativeEligibleTotalUsd.toFixed(2)}`
      : null,
    coupon: current ? namesiloOffer.affiliateCouponCode : null,
    referralUrl: commercialLinks.links.search.referral,
    directUrl: commercialLinks.links.search.direct,
  };
}

export function chatGptSetupContent(now = new Date()): GuideSetupContent {
  const current = snapshotIsCurrent(chatGptGuide.verifiedAt, chatGptGuide.staleAfterDays, now);
  return {
    current,
    sourceUrl: chatGptGuide.source,
    connectionUrl: current ? chatGptGuide.connectionPage : null,
    developerModePath: current ? [...chatGptGuide.developerModePath] : [],
    expectedToolCount: 27,
    fallbackText: chatGptGuide.fallbackText,
  };
}

export function officialSetupDocs(): string[] {
  return [
    ...Object.values(cloudflareDocs.officialDocs),
    chatGptGuide.source,
  ];
}
