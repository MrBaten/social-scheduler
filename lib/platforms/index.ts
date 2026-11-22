import type { AccountWithTokens, Platform, Provider, PublishContent, PublishResult } from "../types";
import type { PlatformPublisher, ProviderAdapter } from "./types";
import { PLATFORM_RULES, validateContent } from "./rules";
import { demoAccountsFor, demoPublish } from "./demo";
import { facebookPublisher, instagramPublisher, metaProvider } from "./meta";
import { linkedinProvider, linkedinPublisher } from "./linkedin";
import { googleProvider, youtubePublisher } from "./google";
import { tiktokProvider, tiktokPublisher } from "./tiktok";

export { PLATFORM_RULES, demoAccountsFor };
export type { ConnectedAccount, PlatformPublisher, PlatformRules, ProviderAdapter, TokenRefreshResult } from "./types";

const PROVIDER_ADAPTERS: Record<Provider, ProviderAdapter> = {
  meta: metaProvider,
  linkedin: linkedinProvider,
  google: googleProvider,
  tiktok: tiktokProvider,
};

const PUBLISHERS: Record<Platform, PlatformPublisher> = {
  facebook: facebookPublisher,
  instagram: instagramPublisher,
  linkedin: linkedinPublisher,
  youtube: youtubePublisher,
  tiktok: tiktokPublisher,
};

export function getProviderAdapter(p: Provider): ProviderAdapter {
  const a = PROVIDER_ADAPTERS[p];
  if (!a) throw new Error(`Unknown provider: ${p}`);
  return a;
}

/** Real publisher (network). Demo publishing is handled by publishTo(). */
export function getPublisher(p: Platform): PlatformPublisher {
  const pub = PUBLISHERS[p];
  if (!pub) throw new Error(`Unknown platform: ${p}`);
  return pub;
}

/** Human-readable problems for this platform; empty array = OK. Pure, no network. */
export function validateForPlatform(p: Platform, c: PublishContent): string[] {
  return validateContent(p, c);
}

/** Publish choosing demo vs real by account.is_demo. Throws PublishError on failure. */
export function publishTo(account: AccountWithTokens, c: PublishContent): Promise<PublishResult> {
  const content: PublishContent = { text: c.text ?? "", media: c.media ?? [], options: c.options ?? {} };
  if (account.is_demo) return demoPublish(account, content);
  return getPublisher(account.platform).publish(account, content);
}
