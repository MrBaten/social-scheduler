// Shared domain types. Every module (UI, API, scheduler, adapters) uses these.

/** A destination a post can be published to. */
export type Platform = "facebook" | "instagram" | "linkedin" | "youtube" | "tiktok";

/**
 * An OAuth provider. One provider connection can yield accounts on several
 * platforms: "meta" yields Facebook Pages AND their linked Instagram business
 * accounts; "google" yields YouTube channels.
 */
export type Provider = "meta" | "linkedin" | "google" | "tiktok";

export const PLATFORMS: Platform[] = ["facebook", "instagram", "linkedin", "youtube", "tiktok"];
export const PROVIDERS: Provider[] = ["meta", "linkedin", "google", "tiktok"];

export const PROVIDER_PLATFORMS: Record<Provider, Platform[]> = {
  meta: ["facebook", "instagram"],
  linkedin: ["linkedin"],
  google: ["youtube"],
  tiktok: ["tiktok"],
};

export type PostStatus = "draft" | "scheduled" | "publishing" | "published" | "partial" | "failed";
export type TargetStatus = "pending" | "publishing" | "published" | "failed";
export type AccountStatus = "active" | "expired" | "error";

export interface User {
  id: string;
  email: string;
  name: string;
  created_at: string;
}

/** Row in social_accounts, tokens still encrypted. Never send tokens to the browser. */
export interface SocialAccountRow {
  id: string;
  user_id: string;
  provider: Provider;
  platform: Platform;
  platform_account_id: string; // page id, IG user id, LinkedIn person/org URN, YT channel id, TikTok open_id
  display_name: string;
  avatar_url: string | null;
  access_token_enc: string;
  refresh_token_enc: string | null;
  token_expires_at: string | null; // ISO UTC
  scopes: string | null;
  meta_json: string; // JSON: platform-specific extras (e.g. {"kind":"organization"} for LinkedIn)
  is_demo: 0 | 1;
  status: AccountStatus;
  created_at: string;
}

/** Safe-for-browser account view. */
export interface SocialAccountPublic {
  id: string;
  provider: Provider;
  platform: Platform;
  platform_account_id: string;
  display_name: string;
  avatar_url: string | null;
  is_demo: boolean;
  status: AccountStatus;
  token_expires_at: string | null;
  created_at: string;
}

/** Decrypted account handed to adapters at publish time. */
export interface AccountWithTokens {
  id: string;
  provider: Provider;
  platform: Platform;
  platform_account_id: string;
  display_name: string;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string | null;
  meta: Record<string, unknown>;
  is_demo: boolean;
}

export interface MediaRow {
  id: string;
  user_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  path: string; // absolute path on disk
  public_url: string; // absolute URL a platform server can fetch (Instagram/TikTok pull from URL)
  created_at: string;
}

export interface MediaItem {
  id: string;
  mime_type: string;
  kind: "image" | "video";
  path: string;
  public_url: string;
  size_bytes: number;
  filename: string;
}

/** Per-platform options a user can set in the composer. */
export interface TargetOptions {
  /** YouTube: video title (required for YouTube). */
  title?: string;
  /** YouTube / TikTok privacy. */
  privacy?: "public" | "private" | "unlisted" | "self_only" | "friends";
  /** Instagram: "feed" (default) | "reel" | "story". */
  ig_type?: "feed" | "reel" | "story";
  /** Facebook: optional link to attach. */
  link?: string;
}

/** Everything an adapter needs to publish one target. */
export interface PublishContent {
  text: string; // final text (override or base)
  media: MediaItem[];
  options: TargetOptions;
}

export interface PublishResult {
  platform_post_id: string;
  platform_post_url: string | null;
}

/** Thrown by adapters. retryable=false => mark failed immediately (e.g. validation, revoked token). */
export class PublishError extends Error {
  constructor(message: string, public retryable: boolean = true, public tokenExpired: boolean = false) {
    super(message);
    this.name = "PublishError";
  }
}

export interface PostRow {
  id: string;
  user_id: string;
  base_text: string;
  scheduled_at: string | null; // ISO UTC; null for drafts
  status: PostStatus;
  created_at: string;
  updated_at: string;
}

export interface PostTargetRow {
  id: string;
  post_id: string;
  social_account_id: string;
  platform: Platform;
  text_override: string | null;
  options_json: string; // JSON TargetOptions
  status: TargetStatus;
  attempts: number;
  next_attempt_at: string | null; // ISO UTC
  last_error: string | null;
  platform_post_id: string | null;
  platform_post_url: string | null;
  published_at: string | null;
}

/** API shape returned by GET /api/posts and GET /api/posts/[id]. */
export interface PostWithTargets extends PostRow {
  media: { id: string; public_url: string; mime_type: string; filename: string }[];
  targets: (PostTargetRow & { account_display_name: string })[];
}

/** Body for POST /api/posts and PATCH /api/posts/[id]. */
export interface CreatePostInput {
  base_text: string;
  media_ids: string[];
  scheduled_at: string | null; // ISO; null => draft. "now" handled by client sending current time.
  targets: {
    social_account_id: string;
    text_override?: string | null;
    options?: TargetOptions;
  }[];
}
