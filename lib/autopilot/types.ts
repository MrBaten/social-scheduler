// AutoPilot domain types (rows + API shapes). Browser-safe: no server imports.

export type ApLanguage = "bn" | "en" | "both";
export type ApApprovalMode = "manual" | "assisted" | "full_auto";
export type ApStatus = "active" | "paused";
/** Source kinds. Add a new kind (e.g. "feedly") by adding an adapter in lib/autopilot/sources.ts. */
export type ApSourceType = "rss" | "google_news" | "gdelt";
export const AP_SOURCE_TYPES: ApSourceType[] = ["rss", "google_news", "gdelt"];

/** Platforms AutoPilot writes for in version 1 (spec: no video / YouTube / TikTok output). */
export type ApPlatform = "facebook" | "instagram" | "linkedin";
export const AP_PLATFORMS: ApPlatform[] = ["facebook", "instagram", "linkedin"];

export type ApItemStatus = "new" | "clustered" | "archived";
export type ApTopicStatus = "new" | "used" | "archived" | "blocked";
export type ApDraftStatus = "in_review" | "approved" | "rejected" | "scheduled";

export interface AutopilotRow {
  id: string;
  user_id: string;
  name: string;
  niche_description: string;
  keywords_json: string;
  region_terms_json: string;
  banned_terms_json: string;
  language: ApLanguage;
  timezone: string;
  frequency_minutes: number;
  window_start: string; // "HH:MM" local
  window_end: string; // "HH:MM" local
  daily_cap: number;
  min_gap_minutes: number;
  approval_mode: ApApprovalMode;
  auto_threshold: number;
  max_age_hours: number;
  min_score: number;
  ai_daily_cap: number;
  account_ids_json: string;
  status: ApStatus;
  paused_reason: string | null;
  lock_until: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Autopilot with JSON columns parsed. What the API returns. */
export interface Autopilot {
  id: string;
  name: string;
  niche_description: string;
  keywords: string[];
  region_terms: string[];
  banned_terms: string[];
  language: ApLanguage;
  timezone: string;
  frequency_minutes: number;
  window_start: string;
  window_end: string;
  daily_cap: number;
  min_gap_minutes: number;
  approval_mode: ApApprovalMode;
  auto_threshold: number;
  max_age_hours: number;
  min_score: number;
  ai_daily_cap: number;
  account_ids: string[];
  status: ApStatus;
  paused_reason: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApSourceParams {
  /** google_news: interface language, e.g. "bn" or "en". */
  hl?: string;
  /** google_news: country edition, e.g. "BD". */
  gl?: string;
  /** google_news: "<country>:<lang>", e.g. "BD:bn". Derived from hl/gl when empty. */
  ceid?: string;
  /** gdelt: e.g. "1d", "12h". Minimum 15 min per GDELT docs. */
  timespan?: string;
  /** gdelt: 1–250. */
  maxrecords?: number;
}

export interface ApSourceRow {
  id: string;
  autopilot_id: string;
  user_id: string;
  type: ApSourceType;
  label: string;
  url: string | null;
  query: string | null;
  params_json: string;
  interval_minutes: number;
  enabled: 0 | 1;
  last_fetched_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  error_count: number;
  item_count: number;
  created_at: string;
}

export interface ApSource {
  id: string;
  autopilot_id: string;
  type: ApSourceType;
  label: string;
  url: string | null;
  query: string | null;
  params: ApSourceParams;
  interval_minutes: number;
  enabled: boolean;
  last_fetched_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  error_count: number;
  item_count: number;
  created_at: string;
}

export interface ApItemRow {
  id: string;
  autopilot_id: string;
  source_id: string | null;
  topic_id: string | null;
  url: string;
  url_norm: string;
  title: string;
  title_key: string;
  summary: string;
  publisher: string;
  published_at: string | null;
  fetched_at: string;
  lang: string | null;
  relevance: number | null;
  status: ApItemStatus;
  archive_reason: string | null;
}

export interface ApTopicRow {
  id: string;
  autopilot_id: string;
  headline: string;
  tokens_json: string;
  item_count: number;
  best_score: number;
  best_item_id: string | null;
  status: ApTopicStatus;
  first_seen_at: string;
  last_seen_at: string;
  used_at: string | null;
  created_at: string;
}

export interface ApTemplateRow {
  id: string;
  autopilot_id: string;
  user_id: string;
  name: string;
  platform: ApPlatform | "all";
  structure: string;
  tone_notes: string;
  hashtag_rules: string;
  card_design_json: string;
  enabled: 0 | 1;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApTemplate {
  id: string;
  autopilot_id: string;
  name: string;
  platform: ApPlatform | "all";
  structure: string;
  tone_notes: string;
  hashtag_rules: string;
  enabled: boolean;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export type DraftTexts = Partial<Record<ApPlatform, string>>;

export interface QcFlag {
  code: "no_ai" | "over_length" | "banned_term" | "unverified_numbers" | "missing_link" | "empty_text";
  platform?: ApPlatform;
  message: string;
}

export interface ApDraftRow {
  id: string;
  autopilot_id: string;
  user_id: string;
  topic_id: string | null;
  template_id: string | null;
  item_id: string | null;
  headline: string;
  source_url: string;
  source_name: string;
  source_summary: string;
  texts_json: string;
  image_media_id: string | null;
  qc_score: number | null;
  qc_flags_json: string;
  status: ApDraftStatus;
  slot_at: string | null;
  generator: string;
  reviewer_id: string | null;
  reviewed_at: string | null;
  reject_reason: string | null;
  post_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApDraft {
  id: string;
  autopilot_id: string;
  topic_id: string | null;
  template_id: string | null;
  template_name: string | null;
  headline: string;
  source_url: string;
  source_name: string;
  source_summary: string;
  /** Other outlets covering the same story (from the topic cluster). */
  related: { title: string; url: string; publisher: string }[];
  texts: DraftTexts;
  image: { id: string; public_url: string; mime_type: string } | null;
  qc_score: number | null;
  qc_flags: QcFlag[];
  status: ApDraftStatus;
  slot_at: string | null;
  generator: string;
  reviewed_at: string | null;
  reject_reason: string | null;
  post_id: string | null;
  /** Live status of the queued post, when there is one. */
  post_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApRun {
  id: string;
  autopilot_id: string;
  trigger: "worker" | "manual";
  step: string;
  started_at: string;
  finished_at: string | null;
  counts: Record<string, number>;
  ai_calls: number;
  error: string | null;
}

export interface AutopilotTodayStats {
  found: number;
  drafted: number;
  approved: number;
  published: number;
  failed: number;
  inbox: number;
  ai_calls: number;
}

export interface AutopilotSummary extends Autopilot {
  today: AutopilotTodayStats;
  next_slot_at: string | null;
  sources_count: number;
  sources_failing: number;
  /** Connected accounts this autopilot posts to that are expired (needs Reconnect). */
  expired_accounts: string[];
}

/** One item fetched from a source, before it is stored. */
export interface FeedItem {
  url: string;
  title: string;
  summary: string;
  publisher: string;
  published_at: string | null;
}
