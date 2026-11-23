import { getDb, newId, nowIso } from "../db";
import { HttpError } from "../api";
import type { ApItemRow, ApPlatform, ApTemplateRow, ApTopicRow, AutopilotRow, AutopilotSummary, DraftTexts } from "./types";
import { AP_PLATFORMS } from "./types";
import { aiStatus, createAiClient, type AiClient } from "./ai";
import { generatePosts, type TemplateInput } from "./generate";
import { archiveStaleTopics, dueSources, ingestSource, processNewItems, sanitizeError, TOPIC_WINDOW_MS } from "./ingest";
import { freshness } from "./relevance";
import { localDayBounds, openSlot, upcomingSlots } from "./slots";
import { slotConfigOf } from "./handoff";
import { isGloballyPaused, pauseAutopilotSystem, toAutopilot } from "./store";
import { safeJsonArray, storySimilarity, tokenSet } from "./text";
import type { SourceFetcher } from "./sources";
import { fetchSourceItems } from "./sources";

// One pass of steps 1–5 for one autopilot. Called by the worker loop every minute (each source is
// only fetched when its interval is due) and by "Run now". Generation happens only for an open
// posting slot (from 20 min before it), or immediately on "Run now". Drafts always go to the inbox
// in Phase 1: nothing here creates posts.

export interface RunOptions {
  trigger: "worker" | "manual";
  now?: Date;
  /** Fetch every enabled source now, ignoring intervals (Run now). */
  forceFetch?: boolean;
  /** Generate one draft now, ignoring slot timing (Run now). Caps still apply. */
  forceGenerate?: boolean;
  fetcher?: SourceFetcher;
  /** null = no AI (template fill). undefined = use the configured provider, if any. */
  ai?: AiClient | null;
}

export interface RunResult {
  ran: boolean;
  skipped_reason: string | null;
  counts: Record<string, number>;
  draft_id: string | null;
  notes: string[];
  error: string | null;
}

const LOCK_MS = 10 * 60_000;
/** After a failed generation, wait this long before the worker tries again (protects AI budget). */
const GENERATION_RETRY_MS = 10 * 60_000;
const REPEAT_SIMILARITY = 0.4;

/** Take the per-autopilot lock. Returns the token (the exact lock_until written) or null. */
function acquireLock(id: string, now: Date): string | null {
  const until = new Date(Math.max(now.getTime(), Date.now()) + LOCK_MS).toISOString();
  const ok =
    getDb()
      .prepare("UPDATE autopilots SET lock_until = ? WHERE id = ? AND (lock_until IS NULL OR lock_until < ?)")
      .run(until, id, new Date(Math.max(now.getTime(), Date.now())).toISOString()).changes === 1;
  return ok ? until : null;
}

/** Extend the lock while a long run is still working; returns the new token (or the old one if lost). */
function refreshLock(id: string, token: string): string {
  const until = new Date(Date.now() + LOCK_MS).toISOString();
  const ok = getDb().prepare("UPDATE autopilots SET lock_until = ? WHERE id = ? AND lock_until = ?").run(until, id, token).changes === 1;
  return ok ? until : token;
}

/** Release only our own lock (compare-and-release), never one another run took over. */
function releaseLock(id: string, token: string): void {
  getDb().prepare("UPDATE autopilots SET lock_until = NULL WHERE id = ? AND lock_until = ?").run(id, token);
  getDb().prepare("UPDATE autopilots SET last_run_at = ? WHERE id = ?").run(nowIso(), id);
}

/** Process-wide guard on the owner's AI key: calls by all of one user's autopilots in 24 h. */
export function aiUserDailyLimit(): number {
  const n = Number(process.env.AI_DAILY_CALLS_PER_USER);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 300;
}

export function aiCallsLast24hForUser(userId: string, now: Date): number {
  const r = getDb()
    .prepare("SELECT COALESCE(SUM(ai_calls), 0) AS n FROM ap_runs WHERE user_id = ? AND started_at >= ?")
    .get(userId, new Date(now.getTime() - 86_400_000).toISOString()) as { n: number };
  return r.n;
}

export function aiCallsToday(ap: AutopilotRow, now: Date): number {
  const { start, end } = localDayBounds(now, ap.timezone);
  const r = getDb()
    .prepare("SELECT COALESCE(SUM(ai_calls), 0) AS n FROM ap_runs WHERE autopilot_id = ? AND started_at >= ? AND started_at < ?")
    .get(ap.id, start.toISOString(), end.toISOString()) as { n: number };
  return r.n;
}

function draftsToday(ap: AutopilotRow, now: Date): number {
  const { start, end } = localDayBounds(now, ap.timezone);
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM ap_drafts WHERE autopilot_id = ? AND created_at >= ? AND created_at < ?")
      .get(ap.id, start.toISOString(), end.toISOString()) as { n: number }
  ).n;
}

/** Platforms of the autopilot's (existing) accounts; all three when none are chosen yet. */
export function platformsOf(ap: AutopilotRow): ApPlatform[] {
  const ids = safeJsonArray(ap.account_ids_json);
  const stmt = getDb().prepare("SELECT platform FROM social_accounts WHERE id = ? AND user_id = ?");
  const set = new Set<ApPlatform>();
  for (const id of ids) {
    const r = stmt.get(id, ap.user_id) as { platform: string } | undefined;
    if (r && (AP_PLATFORMS as string[]).includes(r.platform)) set.add(r.platform as ApPlatform);
  }
  return set.size ? AP_PLATFORMS.filter((p) => set.has(p)) : [...AP_PLATFORMS];
}

function expiredAccounts(ap: AutopilotRow): string[] {
  const ids = safeJsonArray(ap.account_ids_json);
  const stmt = getDb().prepare("SELECT display_name, platform, status FROM social_accounts WHERE id = ? AND user_id = ?");
  const out: string[] = [];
  for (const id of ids) {
    const r = stmt.get(id, ap.user_id) as { display_name: string; platform: string; status: string } | undefined;
    if (r && r.status === "expired") out.push(`${r.display_name} (${r.platform})`);
  }
  return out;
}

/** Step 4: best open topic by relevance × freshness, not repeating a story drafted in the last 72 h. */
export function pickTopic(ap: AutopilotRow, now: Date = new Date()): { topic: ApTopicRow; item: ApItemRow } | null {
  const db = getDb();
  const since = new Date(now.getTime() - ap.max_age_hours * 3_600_000).toISOString();
  const topics = db
    .prepare("SELECT * FROM ap_topics WHERE autopilot_id = ? AND status = 'new' AND best_score >= ? AND last_seen_at >= ?")
    .all(ap.id, ap.min_score, since) as ApTopicRow[];
  if (!topics.length) return null;

  const recent = db
    .prepare("SELECT headline, source_summary FROM ap_drafts WHERE autopilot_id = ? AND created_at >= ?")
    .all(ap.id, new Date(now.getTime() - TOPIC_WINDOW_MS).toISOString()) as { headline: string; source_summary: string }[];
  const recentSets = recent.map((r) => ({ title: tokenSet(r.headline), all: tokenSet(`${r.headline} ${r.source_summary}`) }));
  const itemStmt = db.prepare("SELECT * FROM ap_items WHERE id = ?");

  let best: { topic: ApTopicRow; item: ApItemRow; rank: number } | null = null;
  for (const t of topics) {
    const item = t.best_item_id ? (itemStmt.get(t.best_item_id) as ApItemRow | undefined) : undefined;
    if (!item) continue;
    const me = { title: tokenSet(t.headline), all: new Set(safeJsonArray(t.tokens_json)) };
    if (recentSets.some((r) => storySimilarity(me, r) >= REPEAT_SIMILARITY)) {
      db.prepare("UPDATE ap_topics SET status = 'archived' WHERE id = ?").run(t.id);
      continue;
    }
    const ageH = (now.getTime() - Date.parse(item.published_at ?? item.fetched_at)) / 3_600_000;
    const rank = t.best_score * freshness(ageH);
    if (!best || rank > best.rank) best = { topic: t, item, rank };
  }
  return best ? { topic: best.topic, item: best.item } : null;
}

const DEFAULT_TEMPLATE: TemplateInput = {
  name: "Default",
  structure: "{headline}\n\n{summary}\n\nSource: {source}\n{link}",
  tone_notes: "Clear, neutral and informative.",
  hashtag_rules: "2–3 relevant hashtags at the end.",
};

/** For each platform: a platform-specific template if any, else an 'all' one; least recently used first. */
export function chooseTemplates(ap: AutopilotRow, platforms: ApPlatform[]): { byPlatform: Partial<Record<ApPlatform, TemplateInput>>; used: ApTemplateRow[] } {
  const rows = getDb()
    .prepare("SELECT * FROM ap_templates WHERE autopilot_id = ? AND enabled = 1 ORDER BY COALESCE(last_used_at, '') ASC, created_at ASC")
    .all(ap.id) as ApTemplateRow[];
  const byPlatform: Partial<Record<ApPlatform, TemplateInput>> = {};
  const used = new Map<string, ApTemplateRow>();
  const general = rows.find((r) => r.platform === "all");
  for (const p of platforms) {
    const t = rows.find((r) => r.platform === p) ?? general;
    if (t) {
      byPlatform[p] = t;
      used.set(t.id, t);
    } else byPlatform[p] = DEFAULT_TEMPLATE;
  }
  return { byPlatform, used: [...used.values()] };
}

export interface DraftInputs {
  ap: AutopilotRow;
  topic: ApTopicRow;
  item: ApItemRow;
}

/** Step 5 for one topic. Returns generated texts; throws on AI errors. */
export async function writeDraftTexts(
  { ap, topic, item }: DraftInputs,
  ai: AiClient | null,
): Promise<{ texts: DraftTexts; flags: unknown[]; generator: string; ai_calls: number; template: ApTemplateRow | null }> {
  const platforms = platformsOf(ap);
  const { byPlatform, used } = chooseTemplates(ap, platforms);
  const related = getDb()
    .prepare("SELECT title FROM ap_items WHERE topic_id = ? AND id <> ? ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT 5")
    .all(topic.id, item.id) as { title: string }[];
  const st = aiStatus();
  const r = await generatePosts(
    {
      story: {
        headline: item.title,
        summary: item.summary,
        source_name: item.publisher,
        source_url: item.url,
        published_at: item.published_at,
        related_headlines: related.map((x) => x.title),
      },
      platforms,
      templates: byPlatform,
      language: ap.language,
      niche_description: ap.niche_description,
      banned_terms: safeJsonArray(ap.banned_terms_json),
    },
    ai,
    `ai:${st.provider}/${st.model}`,
  );
  return { ...r, template: used[0] ?? null };
}

function resolveAi(opt: AiClient | null | undefined): AiClient | null {
  if (opt !== undefined) return opt;
  return aiStatus().configured ? createAiClient() : null;
}

export async function runAutopilot(autopilotId: string, opts: RunOptions): Promise<RunResult> {
  const now = opts.now ?? new Date();
  const db = getDb();
  const result: RunResult = { ran: false, skipped_reason: null, counts: {}, draft_id: null, notes: [], error: null };
  const ap0 = db.prepare("SELECT * FROM autopilots WHERE id = ?").get(autopilotId) as AutopilotRow | undefined;
  if (!ap0) return { ...result, skipped_reason: "not found" };
  if (opts.trigger === "worker" && (ap0.status !== "active" || isGloballyPaused(ap0.user_id))) {
    return { ...result, skipped_reason: "paused" };
  }
  let lockToken = acquireLock(ap0.id, now);
  if (!lockToken) return { ...result, skipped_reason: "already running" };

  const runId = newId("run_");
  db.prepare("INSERT INTO ap_runs (id, autopilot_id, user_id, trigger, step, started_at) VALUES (?, ?, ?, ?, 'run', ?)").run(
    runId, ap0.id, ap0.user_id, opts.trigger, now.toISOString(),
  );
  const counts: Record<string, number> = { sources_fetched: 0, source_errors: 0, items_found: 0, duplicates: 0, scored: 0, archived: 0, new_topics: 0, joined: 0, drafts: 0 };
  let aiCalls = 0;
  let error: string | null = null;
  const steps: string[] = [];
  /** Set when something happened worth keeping in the Activity log even without other steps. */
  let significant = false;

  try {
    result.ran = true;
    // 1. Ingest
    const sources = dueSources(ap0.id, now, !!opts.forceFetch);
    if (sources.length) steps.push("ingest");
    for (const s of sources) {
      const r = await ingestSource(s, opts.fetcher ?? fetchSourceItems, now);
      lockToken = refreshLock(ap0.id, lockToken);
      counts.sources_fetched++;
      if (r.error) {
        counts.source_errors++;
        result.notes.push(`${s.label}: ${r.error}`);
      }
      counts.items_found += r.inserted;
      counts.duplicates += r.duplicates;
    }
    // 2–3. Dedupe by meaning + relevance
    const ap = db.prepare("SELECT * FROM autopilots WHERE id = ?").get(ap0.id) as AutopilotRow;
    const pr = processNewItems(ap, now);
    if (pr.scored) steps.push("score");
    Object.assign(counts, { scored: pr.scored, archived: pr.archived, new_topics: pr.new_topics, joined: pr.joined });
    archiveStaleTopics(ap, now);

    // 4–5. Pick + generate
    const paused = ap.status !== "active" || isGloballyPaused(ap.user_id);
    let slot: Date | null = null;
    let generate = false;
    if (paused) {
      if (opts.forceGenerate) result.notes.push("Autopilot is paused: fetched sources but wrote no draft.");
    } else if (opts.forceGenerate) generate = true;
    else {
      const used = new Set(
        (db.prepare("SELECT slot_at FROM ap_drafts WHERE autopilot_id = ? AND slot_at IS NOT NULL AND slot_at >= ?").all(
          ap.id,
          new Date(now.getTime() - 2 * 86_400_000).toISOString(),
        ) as { slot_at: string }[]).map((r) => r.slot_at),
      );
      slot = openSlot(now, slotConfigOf(ap), used);
      if (slot) {
        const lastFail = db
          .prepare("SELECT 1 FROM ap_runs WHERE autopilot_id = ? AND step LIKE '%generate%' AND error IS NOT NULL AND started_at >= ? LIMIT 1")
          .get(ap.id, new Date(now.getTime() - GENERATION_RETRY_MS).toISOString());
        generate = !lastFail;
      }
    }

    if (generate) {
      const expired = expiredAccounts(ap);
      if (expired.length) {
        pauseAutopilotSystem(ap.id, `Reconnect ${expired.join(", ")} on the Accounts page, then resume.`);
        result.notes.push(`Paused: account expired (${expired.join(", ")}).`);
        significant = true;
        generate = false;
      }
    }
    if (generate && draftsToday(ap, now) >= ap.daily_cap) {
      result.notes.push(`Daily cap of ${ap.daily_cap} drafts reached.`);
      generate = false;
    }
    const ai = generate ? resolveAi(opts.ai) : null;
    if (generate && ai && aiCallsToday(ap, now) >= ap.ai_daily_cap) {
      pauseAutopilotSystem(ap.id, `AI daily cap of ${ap.ai_daily_cap} calls reached. Resume tomorrow or raise the cap in Settings.`);
      result.notes.push("Paused: AI daily cap reached.");
      significant = true;
      generate = false;
    }
    if (generate && ai && aiCallsLast24hForUser(ap.user_id, now) >= aiUserDailyLimit()) {
      result.notes.push(`Account-wide AI limit of ${aiUserDailyLimit()} calls per 24 h reached (AI_DAILY_CALLS_PER_USER); no draft written.`);
      generate = false;
    }

    if (generate) {
      const pick = pickTopic(ap, now);
      if (!pick) result.notes.push("No new topic above the minimum score yet.");
      else {
        steps.push("generate");
        try {
          const g = await writeDraftTexts({ ap, ...pick }, ai);
          aiCalls += g.ai_calls;
          const id = newId("dr_");
          const ts = now.toISOString();
          db.transaction(() => {
            db.prepare(
              `INSERT INTO ap_drafts (id, autopilot_id, user_id, topic_id, template_id, item_id, headline, source_url, source_name,
                 source_summary, texts_json, qc_flags_json, status, slot_at, generator, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_review', ?, ?, ?, ?)`,
            ).run(
              id, ap.id, ap.user_id, pick.topic.id, g.template?.id ?? null, pick.item.id, pick.item.title, pick.item.url,
              pick.item.publisher, pick.item.summary, JSON.stringify(g.texts), JSON.stringify(g.flags), slot?.toISOString() ?? null,
              g.generator, ts, ts,
            );
            db.prepare("UPDATE ap_topics SET status = 'used', used_at = ? WHERE id = ?").run(ts, pick.topic.id);
            if (g.template) db.prepare("UPDATE ap_templates SET last_used_at = ? WHERE id = ?").run(ts, g.template.id);
          })();
          counts.drafts = 1;
          result.draft_id = id;
        } catch (e) {
          // An AI call that failed still counts against the budget.
          if (ai) aiCalls += 1;
          throw e;
        }
      }
    }
  } catch (e) {
    error = sanitizeError(e instanceof Error ? e.message : String(e));
  } finally {
    db.prepare("UPDATE ap_runs SET step = ?, finished_at = ?, counts_json = ?, ai_calls = ?, error = ? WHERE id = ?").run(
      steps.join("+") || "idle",
      nowIso(),
      JSON.stringify(counts),
      aiCalls,
      error,
      runId,
    );
    releaseLock(ap0.id, lockToken);
  }
  // Keep only worker runs that did something (fetched, scored, generated, failed, or paused the
  // autopilot). "No topic yet" checks happen every minute while a slot is open and would flood the log.
  if (opts.trigger === "worker" && !error && steps.length === 0 && !significant) {
    db.prepare("DELETE FROM ap_runs WHERE id = ?").run(runId);
  }
  return { ...result, counts, error };
}

/** Regenerate texts for a draft in review (same story, fresh wording). Counts one AI call. */
export async function regenerateDraft(userId: string, draftId: string, opts: { ai?: AiClient | null; now?: Date } = {}): Promise<void> {
  const db = getDb();
  const now = opts.now ?? new Date();
  const d = db.prepare("SELECT * FROM ap_drafts WHERE id = ? AND user_id = ?").get(draftId, userId) as
    | { autopilot_id: string; topic_id: string | null; item_id: string | null; status: string }
    | undefined;
  if (!d) throw new HttpError(404, "Draft not found");
  if (d.status !== "in_review") throw new HttpError(409, "Only drafts in review can be regenerated");
  const ap = db.prepare("SELECT * FROM autopilots WHERE id = ? AND user_id = ?").get(d.autopilot_id, userId) as AutopilotRow;
  const item = d.item_id ? (db.prepare("SELECT * FROM ap_items WHERE id = ?").get(d.item_id) as ApItemRow | undefined) : undefined;
  const topic = d.topic_id ? (db.prepare("SELECT * FROM ap_topics WHERE id = ?").get(d.topic_id) as ApTopicRow | undefined) : undefined;
  if (!item || !topic) throw new HttpError(409, "The source story for this draft is gone");
  const ai = resolveAi(opts.ai);
  if (ai && aiCallsToday(ap, now) >= ap.ai_daily_cap) {
    throw new HttpError(429, `AI daily cap of ${ap.ai_daily_cap} calls reached`);
  }
  if (ai && aiCallsLast24hForUser(userId, now) >= aiUserDailyLimit()) {
    throw new HttpError(429, `Account-wide AI limit of ${aiUserDailyLimit()} calls per 24 h reached`);
  }
  const runId = newId("run_");
  db.prepare("INSERT INTO ap_runs (id, autopilot_id, user_id, trigger, step, started_at) VALUES (?, ?, ?, 'manual', 'regenerate', ?)").run(
    runId, ap.id, userId, now.toISOString(),
  );
  let error: string | null = null;
  try {
    const g = await writeDraftTexts({ ap, topic, item }, ai);
    // Only while still in review: if it was approved/rejected during the AI call, leave it alone.
    const changed = db
      .prepare(
        `UPDATE ap_drafts SET texts_json = ?, qc_flags_json = ?, generator = ?, template_id = COALESCE(?, template_id), updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'in_review'`,
      )
      .run(JSON.stringify(g.texts), JSON.stringify(g.flags), g.generator, g.template?.id ?? null, nowIso(), draftId, userId).changes;
    if (changed !== 1) throw new HttpError(409, "This draft was reviewed while it was being regenerated");
  } catch (e) {
    error = sanitizeError(e instanceof Error ? e.message : String(e));
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, error);
  } finally {
    db.prepare("UPDATE ap_runs SET finished_at = ?, ai_calls = ?, error = ?, counts_json = '{}' WHERE id = ?").run(nowIso(), ai ? 1 : 0, error, runId);
  }
}

// ---------- overview ----------

export function summarizeAutopilots(userId: string, now: Date = new Date()): AutopilotSummary[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM autopilots WHERE user_id = ? ORDER BY created_at").all(userId) as AutopilotRow[];
  return rows.map((r) => {
    const { start, end } = localDayBounds(now, r.timezone);
    const S = start.toISOString();
    const E = end.toISOString();
    const n = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
    const found = n("SELECT COUNT(*) AS n FROM ap_items WHERE autopilot_id = ? AND fetched_at >= ? AND fetched_at < ?", r.id, S, E);
    const drafted = n("SELECT COUNT(*) AS n FROM ap_drafts WHERE autopilot_id = ? AND created_at >= ? AND created_at < ?", r.id, S, E);
    const approved = n(
      "SELECT COUNT(*) AS n FROM ap_drafts WHERE autopilot_id = ? AND status IN ('approved','scheduled') AND reviewed_at >= ? AND reviewed_at < ?",
      r.id, S, E,
    );
    const published = n(
      `SELECT COUNT(*) AS n FROM post_targets t JOIN posts p ON p.id = t.post_id JOIN ap_drafts d ON d.id = p.ap_draft_id
       WHERE d.autopilot_id = ? AND t.status = 'published' AND t.published_at >= ? AND t.published_at < ?`,
      r.id, S, E,
    );
    const failed = n(
      `SELECT COUNT(*) AS n FROM post_targets t JOIN posts p ON p.id = t.post_id JOIN ap_drafts d ON d.id = p.ap_draft_id
       WHERE d.autopilot_id = ? AND t.status = 'failed' AND p.updated_at >= ? AND p.updated_at < ?`,
      r.id, S, E,
    );
    const inbox = n("SELECT COUNT(*) AS n FROM ap_drafts WHERE autopilot_id = ? AND status = 'in_review'", r.id);
    const srcAll = n("SELECT COUNT(*) AS n FROM ap_sources WHERE autopilot_id = ?", r.id);
    const srcBad = n("SELECT COUNT(*) AS n FROM ap_sources WHERE autopilot_id = ? AND (error_count > 0 OR (enabled = 0 AND last_error IS NOT NULL))", r.id);
    const next = upcomingSlots(now, slotConfigOf(r), 2).find((s) => s.getTime() > now.getTime()) ?? null;
    return {
      ...toAutopilot(r),
      today: { found, drafted, approved, published, failed, inbox, ai_calls: aiCallsToday(r, now) },
      next_slot_at: next ? next.toISOString() : null,
      sources_count: srcAll,
      sources_failing: srcBad,
      expired_accounts: expiredAccounts(r),
    };
  });
}

// ---------- housekeeping ----------

/** Items and topics older than this are deleted (drafts keep their own copy of the story). */
export const KEEP_ITEMS_DAYS = 14;
export const KEEP_RUNS_DAYS = 30;

/** Bound table growth on the SQLite volume. Safe any time: dedupe and topics only look back 72 h. */
export function pruneOld(now: Date = new Date()): { items: number; topics: number; runs: number } {
  const db = getDb();
  const itemsCutoff = new Date(now.getTime() - KEEP_ITEMS_DAYS * 86_400_000).toISOString();
  const runsCutoff = new Date(now.getTime() - KEEP_RUNS_DAYS * 86_400_000).toISOString();
  return db.transaction(() => ({
    items: db.prepare("DELETE FROM ap_items WHERE fetched_at < ?").run(itemsCutoff).changes,
    topics: db.prepare("DELETE FROM ap_topics WHERE last_seen_at < ?").run(itemsCutoff).changes,
    runs: db.prepare("DELETE FROM ap_runs WHERE started_at < ?").run(runsCutoff).changes,
  }))();
}
