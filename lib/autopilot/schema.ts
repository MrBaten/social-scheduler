import type Database from "better-sqlite3";

// AutoPilot tables. Everything is prefixed ap_ and only ADDED: the one change to an existing table
// is two new nullable/defaulted columns on posts (origin, ap_draft_id). Safe to run on every start:
// CREATE ... IF NOT EXISTS, and columns are added only when missing.
//
// This file must not import lib/db.ts (lib/db.ts imports this file).

export const AUTOPILOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS autopilots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  niche_description TEXT NOT NULL DEFAULT '',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  region_terms_json TEXT NOT NULL DEFAULT '[]',
  banned_terms_json TEXT NOT NULL DEFAULT '[]',
  language TEXT NOT NULL DEFAULT 'en',
  timezone TEXT NOT NULL DEFAULT 'Asia/Dhaka',
  frequency_minutes INTEGER NOT NULL DEFAULT 120,
  window_start TEXT NOT NULL DEFAULT '08:00',
  window_end TEXT NOT NULL DEFAULT '23:00',
  daily_cap INTEGER NOT NULL DEFAULT 12,
  min_gap_minutes INTEGER NOT NULL DEFAULT 60,
  approval_mode TEXT NOT NULL DEFAULT 'manual',
  auto_threshold INTEGER NOT NULL DEFAULT 85,
  max_age_hours INTEGER NOT NULL DEFAULT 48,
  min_score INTEGER NOT NULL DEFAULT 30,
  ai_daily_cap INTEGER NOT NULL DEFAULT 200,
  account_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  paused_reason TEXT,
  lock_until TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ap_user ON autopilots(user_id);

CREATE TABLE IF NOT EXISTS ap_sources (
  id TEXT PRIMARY KEY,
  autopilot_id TEXT NOT NULL REFERENCES autopilots(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  url TEXT,
  query TEXT,
  params_json TEXT NOT NULL DEFAULT '{}',
  interval_minutes INTEGER NOT NULL DEFAULT 15,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fetched_at TEXT,
  last_ok_at TEXT,
  last_error TEXT,
  error_count INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ap_sources_ap ON ap_sources(autopilot_id);

CREATE TABLE IF NOT EXISTS ap_topics (
  id TEXT PRIMARY KEY,
  autopilot_id TEXT NOT NULL REFERENCES autopilots(id) ON DELETE CASCADE,
  headline TEXT NOT NULL,
  tokens_json TEXT NOT NULL DEFAULT '[]',
  item_count INTEGER NOT NULL DEFAULT 0,
  best_score REAL NOT NULL DEFAULT 0,
  best_item_id TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ap_topics_ap ON ap_topics(autopilot_id, status, last_seen_at);

CREATE TABLE IF NOT EXISTS ap_items (
  id TEXT PRIMARY KEY,
  autopilot_id TEXT NOT NULL REFERENCES autopilots(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES ap_sources(id) ON DELETE SET NULL,
  topic_id TEXT REFERENCES ap_topics(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  url_norm TEXT NOT NULL,
  title TEXT NOT NULL,
  title_key TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  publisher TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  fetched_at TEXT NOT NULL,
  lang TEXT,
  embedding BLOB,
  relevance REAL,
  status TEXT NOT NULL DEFAULT 'new',
  archive_reason TEXT,
  UNIQUE (autopilot_id, url_norm)
);
CREATE INDEX IF NOT EXISTS idx_ap_items_status ON ap_items(autopilot_id, status);
CREATE INDEX IF NOT EXISTS idx_ap_items_title ON ap_items(autopilot_id, title_key);
CREATE INDEX IF NOT EXISTS idx_ap_items_topic ON ap_items(topic_id);
CREATE INDEX IF NOT EXISTS idx_ap_items_fetched ON ap_items(autopilot_id, fetched_at);

CREATE TABLE IF NOT EXISTS ap_templates (
  id TEXT PRIMARY KEY,
  autopilot_id TEXT NOT NULL REFERENCES autopilots(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'all',
  structure TEXT NOT NULL,
  tone_notes TEXT NOT NULL DEFAULT '',
  hashtag_rules TEXT NOT NULL DEFAULT '',
  card_design_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ap_templates_ap ON ap_templates(autopilot_id);

CREATE TABLE IF NOT EXISTS ap_drafts (
  id TEXT PRIMARY KEY,
  autopilot_id TEXT NOT NULL REFERENCES autopilots(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id TEXT REFERENCES ap_topics(id) ON DELETE SET NULL,
  template_id TEXT REFERENCES ap_templates(id) ON DELETE SET NULL,
  item_id TEXT REFERENCES ap_items(id) ON DELETE SET NULL,
  headline TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  source_name TEXT NOT NULL DEFAULT '',
  source_summary TEXT NOT NULL DEFAULT '',
  texts_json TEXT NOT NULL DEFAULT '{}',
  image_media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  qc_score INTEGER,
  qc_flags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'in_review',
  slot_at TEXT,
  generator TEXT NOT NULL DEFAULT '',
  reviewer_id TEXT,
  reviewed_at TEXT,
  reject_reason TEXT,
  post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ap_drafts_ap ON ap_drafts(autopilot_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_ap_drafts_user ON ap_drafts(user_id, status);

CREATE TABLE IF NOT EXISTS ap_runs (
  id TEXT PRIMARY KEY,
  autopilot_id TEXT NOT NULL REFERENCES autopilots(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL DEFAULT 'worker',
  step TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  counts_json TEXT NOT NULL DEFAULT '{}',
  ai_calls INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_ap_runs_ap ON ap_runs(autopilot_id, started_at);

-- One row per user: the global pause switch on the AutoPilot overview.
CREATE TABLE IF NOT EXISTS ap_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  paused INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`;

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

/**
 * Idempotent: creates ap_ tables and adds posts.origin / posts.ap_draft_id when missing. Runs in
 * one IMMEDIATE transaction, so two processes starting at once can't both try the ALTER; a
 * "duplicate column" from any other race is ignored rather than breaking getDb() for the publisher.
 */
export function migrateAutopilot(db: Database.Database): void {
  db.transaction(() => {
    db.exec(AUTOPILOT_SCHEMA);
    addColumn(db, "posts", "origin", "TEXT NOT NULL DEFAULT 'manual'");
    // Plain TEXT (no FK): ap_drafts.post_id already carries the ON DELETE SET NULL link the other way.
    addColumn(db, "posts", "ap_draft_id", "TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_posts_ap_draft ON posts(ap_draft_id)");
  }).immediate();
}

function addColumn(db: Database.Database, table: string, column: string, decl: string): void {
  if (hasColumn(db, table, column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  } catch (e) {
    if (!(e instanceof Error && /duplicate column/i.test(e.message))) throw e;
  }
}
