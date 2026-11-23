import { getDb, newId } from "../db";
import type { ApItemRow, ApSourceRow, ApTopicRow, AutopilotRow, FeedItem } from "./types";
import {
  SAME_STORY_THRESHOLD,
  isMostlyBangla,
  normalizeUrl,
  safeJsonArray,
  safeJsonObject,
  storySimilarity,
  titleKey,
  tokenSet,
  truncate,
} from "./text";
import { scoreItem, topicScore, type NicheProfile } from "./relevance";
import { fetchSourceItems, type SourceFetcher } from "./sources";

// Steps 1–3 of the pipeline: ingest (store new items, exact dedupe), score relevance, and group
// items about the same story into topics (meaning dedupe).

/** A source failing this many times in a row is paused and flagged. */
export const MAX_SOURCE_ERRORS = 5;
/** Topics older than this are not joined by new items and not repeated (spec: 72 h). */
export const TOPIC_WINDOW_MS = 72 * 3_600_000;
const MAX_ITEMS_PER_FETCH = 100;

/** Strip credential-looking parts of an error before storing it (same idea as the scheduler's). */
export function sanitizeError(msg: string): string {
  return msg
    .replace(/(access_token|refresh_token|client_secret|token|key|apikey|api_key)=([^&\s"']+)/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .slice(0, 500);
}

export function profileOf(ap: AutopilotRow): NicheProfile {
  return {
    keywords: safeJsonArray(ap.keywords_json),
    region_terms: safeJsonArray(ap.region_terms_json),
    banned_terms: safeJsonArray(ap.banned_terms_json),
    max_age_hours: ap.max_age_hours,
    min_score: ap.min_score,
  };
}

export interface StoreResult {
  fetched: number;
  inserted: number;
  duplicates: number;
}

/**
 * Store feed items for one autopilot, skipping exact repeats: same normalised URL (UNIQUE index),
 * or the same normalised title already stored in the last 72 h (one story syndicated under
 * several URLs, e.g. Google News redirect links + the outlet's own feed).
 */
export function storeItems(autopilotId: string, sourceId: string | null, items: FeedItem[], now: Date = new Date()): StoreResult {
  const db = getDb();
  const since = new Date(now.getTime() - TOPIC_WINDOW_MS).toISOString();
  const ts = now.toISOString();
  const titleSeen = db.prepare("SELECT 1 FROM ap_items WHERE autopilot_id = ? AND title_key = ? AND fetched_at >= ? LIMIT 1");
  const ins = db.prepare(
    `INSERT OR IGNORE INTO ap_items (id, autopilot_id, source_id, url, url_norm, title, title_key, summary, publisher,
       published_at, fetched_at, lang, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
  );
  let inserted = 0;
  let duplicates = 0;
  const batchTitles = new Set<string>();
  db.transaction(() => {
    for (const it of items.slice(0, MAX_ITEMS_PER_FETCH)) {
      const urlNorm = normalizeUrl(it.url);
      const title = truncate(it.title.trim(), 300);
      if (!urlNorm || !title) continue;
      const key = titleKey(title);
      if (key && (batchTitles.has(key) || titleSeen.get(autopilotId, key, since))) {
        duplicates++;
        continue;
      }
      const r = ins.run(
        newId("it_"), autopilotId, sourceId, it.url.trim(), urlNorm, title, key, it.summary, it.publisher.slice(0, 200),
        it.published_at, ts, isMostlyBangla(`${title} ${it.summary}`) ? "bn" : "en",
      );
      if (r.changes > 0) {
        inserted++;
        if (key) batchTitles.add(key);
      } else duplicates++;
    }
  })();
  return { fetched: items.length, inserted, duplicates };
}

/** Fetch one source and record the outcome on the source row. Never throws. */
export async function ingestSource(
  src: ApSourceRow,
  fetcher: SourceFetcher = fetchSourceItems,
  now: Date = new Date(),
): Promise<StoreResult & { error: string | null }> {
  const db = getDb();
  const ts = now.toISOString();
  try {
    const items = await fetcher({ type: src.type, url: src.url, query: src.query, params: safeJsonObject(src.params_json) });
    const r = storeItems(src.autopilot_id, src.id, items, now);
    db.prepare(
      `UPDATE ap_sources SET last_fetched_at = ?, last_ok_at = ?, last_error = NULL, error_count = 0,
         item_count = item_count + ? WHERE id = ?`,
    ).run(ts, ts, r.inserted, src.id);
    return { ...r, error: null };
  } catch (e) {
    const msg = sanitizeError(e instanceof Error ? e.message : String(e));
    const errors = src.error_count + 1;
    const pause = errors >= MAX_SOURCE_ERRORS;
    db.prepare("UPDATE ap_sources SET last_fetched_at = ?, last_error = ?, error_count = ?, enabled = CASE WHEN ? THEN 0 ELSE enabled END WHERE id = ?").run(
      ts,
      pause ? `Paused after ${errors} failures in a row. Last error: ${msg}` : msg,
      errors,
      pause ? 1 : 0,
      src.id,
    );
    return { fetched: 0, inserted: 0, duplicates: 0, error: msg };
  }
}

export function dueSources(autopilotId: string, now: Date = new Date(), force = false): ApSourceRow[] {
  const rows = getDb().prepare("SELECT * FROM ap_sources WHERE autopilot_id = ? AND enabled = 1 ORDER BY created_at").all(autopilotId) as ApSourceRow[];
  if (force) return rows;
  return rows.filter((s) => !s.last_fetched_at || Date.parse(s.last_fetched_at) + s.interval_minutes * 60_000 <= now.getTime() + 30_000);
}

interface TopicCandidate {
  row: ApTopicRow;
  title: Set<string>;
  all: Set<string>;
}

export interface ProcessResult {
  scored: number;
  archived: number;
  new_topics: number;
  joined: number;
}

/**
 * Score every 'new' item of the autopilot and cluster the relevant ones into topics. An item joins
 * the most similar topic seen in the last 72 h (any status, so a story already posted keeps
 * absorbing its follow-up coverage instead of becoming a "new" topic); otherwise it starts one.
 */
export function processNewItems(ap: AutopilotRow, now: Date = new Date()): ProcessResult {
  const db = getDb();
  const profile = profileOf(ap);
  const items = db
    .prepare("SELECT * FROM ap_items WHERE autopilot_id = ? AND status = 'new' ORDER BY COALESCE(published_at, fetched_at)")
    .all(ap.id) as ApItemRow[];
  const res: ProcessResult = { scored: 0, archived: 0, new_topics: 0, joined: 0 };
  if (!items.length) return res;

  const since = new Date(now.getTime() - TOPIC_WINDOW_MS).toISOString();
  const topicRows = db
    .prepare("SELECT * FROM ap_topics WHERE autopilot_id = ? AND last_seen_at >= ?")
    .all(ap.id, since) as ApTopicRow[];
  const topics: TopicCandidate[] = topicRows.map((row) => {
    const toks = safeJsonArray(row.tokens_json);
    return { row, title: tokenSet(row.headline), all: new Set(toks) };
  });

  const archive = db.prepare("UPDATE ap_items SET status = 'archived', archive_reason = ?, relevance = ? WHERE id = ?");
  const attach = db.prepare("UPDATE ap_items SET status = 'clustered', topic_id = ?, relevance = ? WHERE id = ?");
  const insTopic = db.prepare(
    `INSERT INTO ap_topics (id, autopilot_id, headline, tokens_json, item_count, best_score, best_item_id, status,
       first_seen_at, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, 'new', ?, ?, ?)`,
  );
  const updTopic = db.prepare(
    `UPDATE ap_topics SET item_count = ?, best_score = ?, best_item_id = ?, headline = ?, tokens_json = ?, last_seen_at = ? WHERE id = ?`,
  );
  const ts = now.toISOString();

  db.transaction(() => {
    for (const it of items) {
      res.scored++;
      const sc = scoreItem(it, profile, now);
      if (sc.archive) {
        archive.run(sc.archive, sc.score, it.id);
        res.archived++;
        continue;
      }
      const me = { title: tokenSet(it.title), all: tokenSet(`${it.title} ${it.summary}`) };
      let best: TopicCandidate | null = null;
      let bestSim = 0;
      for (const t of topics) {
        const sim = storySimilarity(me, t);
        if (sim > bestSim) {
          bestSim = sim;
          best = t;
        }
      }
      if (best && bestSim >= SAME_STORY_THRESHOLD) {
        const r = best.row;
        const count = r.item_count + 1;
        const itemBest = Math.max(sc.score, prevBestItemScore(r));
        const isBetter = sc.score > prevBestItemScore(r);
        r.item_count = count;
        r.best_item_id = isBetter ? it.id : r.best_item_id;
        r.headline = isBetter ? it.title : r.headline;
        r.best_score = topicScore(itemBest, count);
        for (const tok of me.all) best.all.add(tok);
        if (isBetter) best.title = me.title;
        r.tokens_json = JSON.stringify([...best.all].slice(0, 200));
        r.last_seen_at = ts;
        updTopic.run(r.item_count, r.best_score, r.best_item_id, r.headline, r.tokens_json, ts, r.id);
        attach.run(r.id, sc.score, it.id);
        res.joined++;
      } else {
        const id = newId("tp_");
        const row: ApTopicRow = {
          id,
          autopilot_id: ap.id,
          headline: it.title,
          tokens_json: JSON.stringify([...me.all].slice(0, 200)),
          item_count: 1,
          best_score: topicScore(sc.score, 1),
          best_item_id: it.id,
          status: "new",
          first_seen_at: ts,
          last_seen_at: ts,
          used_at: null,
          created_at: ts,
        };
        insTopic.run(id, ap.id, row.headline, row.tokens_json, row.best_score, it.id, ts, ts, ts);
        attach.run(id, sc.score, it.id);
        topics.push({ row, title: me.title, all: me.all });
        res.new_topics++;
      }
    }
  })();
  return res;
}

function prevBestItemScore(t: ApTopicRow): number {
  if (!t.best_item_id) return 0;
  const r = getDb().prepare("SELECT relevance FROM ap_items WHERE id = ?").get(t.best_item_id) as { relevance: number | null } | undefined;
  return r?.relevance ?? 0;
}

/** Archive 'new' topics that went stale so the Topics list stays short. */
export function archiveStaleTopics(ap: AutopilotRow, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - ap.max_age_hours * 3_600_000).toISOString();
  return getDb().prepare("UPDATE ap_topics SET status = 'archived' WHERE autopilot_id = ? AND status = 'new' AND last_seen_at < ?").run(ap.id, cutoff).changes;
}

