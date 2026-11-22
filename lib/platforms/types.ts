import type { AccountWithTokens, Platform, Provider, PublishContent, PublishResult } from "../types";

/** What an OAuth code exchange produces: one or more accounts to save. */
export interface ConnectedAccount {
  platform: Platform;
  platform_account_id: string;
  display_name: string;
  avatar_url: string | null;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string | null; // ISO UTC
  scopes: string | null;
  meta: Record<string, unknown>;
}

export interface TokenRefreshResult {
  access_token: string;
  refresh_token: string | null; // null => keep existing
  token_expires_at: string | null;
}

/** One OAuth provider (meta / linkedin / google / tiktok). */
export interface ProviderAdapter {
  provider: Provider;
  label: string; // "Meta (Facebook + Instagram)"
  usesPkce: boolean;
  /** Build the URL to redirect the user to. */
  getAuthUrl(args: { state: string; redirectUri: string; codeChallenge?: string }): string;
  /** Exchange ?code= for tokens and list the accounts the user can post to. */
  exchangeCode(args: { code: string; redirectUri: string; codeVerifier?: string }): Promise<ConnectedAccount[]>;
  /** Refresh an expiring token. Omit if the provider has no refresh flow. */
  refresh?(account: AccountWithTokens): Promise<TokenRefreshResult>;
}

/** Per-platform publishing rules. */
export interface PlatformRules {
  platform: Platform;
  label: string;
  maxTextLength: number;
  requiresMedia: boolean;
  requiresVideo: boolean;
  allowsImages: boolean;
  allowsVideo: boolean;
  maxMediaCount: number;
  /** Extra required option keys, e.g. YouTube needs "title". */
  requiredOptions: (keyof import("../types").TargetOptions)[];
}

/** One publish destination (facebook / instagram / linkedin / youtube / tiktok). */
export interface PlatformPublisher {
  platform: Platform;
  rules: PlatformRules;
  /** Returns human-readable problems; empty array = OK. Pure, no network. */
  validate(content: PublishContent): string[];
  /** Publish now. Throw PublishError on failure. */
  publish(account: AccountWithTokens, content: PublishContent): Promise<PublishResult>;
}
