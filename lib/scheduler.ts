import { getDb, nowIso } from "./db";
import { ensureFreshToken, markAccountStatus } from "./accounts";
import { publishTo, validateForPlatform } from "./platforms";
import { buildPublishContent, recomputePostStatus } from "./posts";
import { PublishError } from "./types";
import type { Platform } from "./types";

// Publishing engine. Safe to call from several places at once (cron route, publish-now,
// scripts/worker.ts, even several processes): targets are claimed with a conditional UPDATE
// inside an IMMEDIATE transaction, so each target is published by exactly one runner.

export const MAX_ATTEMPTS = 4;
/** Wait after the 1st, 2nd, 3rd (, 4th) failed attempt. With MAX_ATTEMPTS = 4 the 4th failure is final. */
export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
export const STALE_LOCK_MS = 15 * 60_000;
/**
 * While a target is being published its locked_at is refreshed this often, so long uploads
 * (YouTube up to 60 min, IG/TikTok/LinkedIn processing polls) are never mistaken for a crashed
 * runner and re-published by another process. Must be well below STALE_LOCK_MS.
 */
export const HEARTBEAT_MS = 60_000;
export const CONCURRENCY = 5;
/** Upper bound of targets handled by one processDuePosts() call. */
const MAX_PER_RUN = 200;

export interface ProcessResult {
  processed: number;
  published: number;
  failed: number;
}

interface ClaimedTarget {
  id: string;
  post_id: string;
  user_id: string;
  base_text: string;
  social_account_id: string;
  platform: Platform;
  text_override: string | null;
  options_json: string;
  attempts: number;
}

/** Strip anything that looks like a credential before storing / logging an error message. */
export function sanitizeError(msg: string): string {
  return msg
    .replace(/(access_token|refresh_token|client_secret|token|code)=([^&\s"']+)/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .slice(0, 1000);
}

/**
 * Put targets stuck in 'publishing' (runner crashed / killed) back in the queue. Counts as a
 * failed attempt so a target that keeps crashing its runner eventually fails.
 */
function reclaimStale(now: Date): void {
  const db = getDb();
  const cutoff = new Date(now.getTime() - STALE_LOCK_MS).toISOString();
  const nowS = now.toISOString();
  const postIds = db
    .transaction(() => {
      const stale = db
        .prepare(
          "SELECT id, post_id, attempts FROM post_targets WHERE status = 'publishing' AND (locked_at IS NULL OR locked_at < ?)",
        )
        .all(cutoff) as { id: string; post_id: string; attempts: number }[];
      const toPending = db.prepare(
        `UPDATE post_targets SET status = 'pending', attempts = ?, next_attempt_at = ?, locked_at = NULL,
           last_error = 'Publishing timed out; retrying'
         WHERE id = ? AND status = 'publishing'`,
      );
      const toFailed = db.prepare(
        `UPDATE post_targets SET status = 'failed', attempts = ?, next_attempt_at = NULL, locked_at = NULL,
           last_error = 'Publishing timed out too many times'
         WHERE id = ? AND status = 'publishing'`,
      );
      for (const s of stale) {
        const attempts = s.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) toFailed.run(attempts, s.id);
        else toPending.run(attempts, nowS, s.id);
      }
      return [...new Set(stale.map((s) => s.post_id))];
    })
    .immediate();
  for (const id of postIds) recomputePostStatus(id);
}

/** Atomically claim ONE due target (pending AND next_attempt_at <= now). */
function claimNext(now: Date): ClaimedTarget | null {
  const db = getDb();
  const nowS = now.toISOString();
  const claimed = db
    .transaction((): ClaimedTarget | null => {
      const due = db
        .prepare(
          `SELECT id FROM post_targets WHERE status = 'pending' AND next_attempt_at IS NOT NULL
             AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 5`,
        )
        .all(nowS) as { id: string }[];
      const upd = db.prepare(
        "UPDATE post_targets SET status = 'publishing', locked_at = ? WHERE id = ? AND status = 'pending'",
      );
      for (const d of due) {
        if (upd.run(nowS, d.id).changes === 1) {
          return db
            .prepare(
              `SELECT t.id, t.post_id, p.user_id, p.base_text, t.social_account_id, t.platform,
                      t.text_override, t.options_json, t.attempts
               FROM post_targets t JOIN posts p ON p.id = t.post_id WHERE t.id = ?`,
            )
            .get(d.id) as ClaimedTarget;
        }
      }
      return null;
    })
    .immediate();
  if (claimed) recomputePostStatus(claimed.post_id);
  return claimed;
}

type Outcome = "published" | "retry" | "failed";

async function processTarget(t: ClaimedTarget, now: Date): Promise<Outcome> {
  const db = getDb();
  const heartbeat = setInterval(() => {
    try {
      db.prepare("UPDATE post_targets SET locked_at = ? WHERE id = ? AND status = 'publishing'").run(nowIso(), t.id);
    } catch (e) {
      console.error("[scheduler] heartbeat failed", e instanceof Error ? e.message : e);
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    const account = await ensureFreshToken(t.user_id, t.social_account_id);
    const content = buildPublishContent({ id: t.post_id, base_text: t.base_text }, t);
    const problems = validateForPlatform(t.platform, content);
    if (problems.length > 0) throw new PublishError(problems.join("; "), false);

    const result = await publishTo(account, content);
    db.prepare(
      `UPDATE post_targets SET status = 'published', attempts = attempts + 1, platform_post_id = ?,
         platform_post_url = ?, published_at = ?, last_error = NULL, locked_at = NULL, next_attempt_at = NULL
       WHERE id = ?`,
    ).run(result.platform_post_id, result.platform_post_url, nowIso(), t.id);
    return "published";
  } catch (err) {
    const pe = err instanceof PublishError ? err : null;
    const raw = err instanceof Error ? err.message : String(err);
    const attempts = t.attempts + 1;

    if (pe?.tokenExpired) {
      try {
        markAccountStatus(t.social_account_id, "expired");
      } catch {
        /* ignore */
      }
      failTarget(t.id, attempts, "Reconnect account");
      console.warn(`[scheduler] target ${t.id} (${t.platform}) failed: token expired`);
      return "failed";
    }
    // Unknown errors (network, 5xx, bugs in an adapter) are treated as retryable.
    const retryable = pe ? pe.retryable : true;
    const msg = sanitizeError(raw || "Unknown error");
    if (!retryable || attempts >= MAX_ATTEMPTS) {
      failTarget(t.id, attempts, msg);
      console.warn(`[scheduler] target ${t.id} (${t.platform}) failed after ${attempts} attempt(s): ${msg}`);
      return "failed";
    }
    const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
    const next = new Date(now.getTime() + delay).toISOString();
    db.prepare(
      `UPDATE post_targets SET status = 'pending', attempts = ?, next_attempt_at = ?, last_error = ?, locked_at = NULL
       WHERE id = ?`,
    ).run(attempts, next, msg, t.id);
    console.warn(`[scheduler] target ${t.id} (${t.platform}) attempt ${attempts} failed, retry at ${next}: ${msg}`);
    return "retry";
  } finally {
    clearInterval(heartbeat);
    try {
      recomputePostStatus(t.post_id);
    } catch (e) {
      console.error("[scheduler] recompute status failed", e instanceof Error ? e.message : e);
    }
  }
}

function failTarget(id: string, attempts: number, msg: string): void {
  getDb()
    .prepare(
      `UPDATE post_targets SET status = 'failed', attempts = ?, last_error = ?, locked_at = NULL, next_attempt_at = NULL
       WHERE id = ?`,
    )
    .run(attempts, msg, id);
}

async function runOnce(fixedNow?: Date): Promise<ProcessResult> {
  const res: ProcessResult = { processed: 0, published: 0, failed: 0 };
  const clock = () => fixedNow ?? new Date();
  try {
    reclaimStale(clock());
  } catch (e) {
    console.error("[scheduler] reclaim failed", e instanceof Error ? e.message : e);
  }

  // CONCURRENCY lanes, each claiming one target just before publishing it, so nothing sits
  // in 'publishing' waiting for a free lane (which could trip the stale-lock reclaim).
  let budget = MAX_PER_RUN;
  const lane = async () => {
    while (budget > 0) {
      budget--;
      let t: ClaimedTarget | null;
      try {
        t = claimNext(clock());
      } catch (e) {
        console.error("[scheduler] claim failed", e instanceof Error ? e.message : e);
        return;
      }
      if (!t) return;
      res.processed++;
      let outcome: Outcome;
      try {
        outcome = await processTarget(t, clock());
      } catch (e) {
        // processTarget catches publish errors itself; this is a DB failure while recording.
        console.error(`[scheduler] target ${t.id} crashed`, e instanceof Error ? e.message : e);
        continue;
      }
      if (outcome === "published") res.published++;
      else if (outcome === "failed") res.failed++;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, lane));
  return res;
}

let running: Promise<ProcessResult> | null = null;
let rerunRequested = false;

/**
 * Publish every due target. If a run is already in progress in this process, the call joins
 * it and a follow-up pass is scheduled so newly due targets aren't missed.
 * `now` is injectable for tests.
 */
export function processDuePosts(now?: Date): Promise<ProcessResult> {
  if (running) {
    rerunRequested = true;
    return running;
  }
  running = (async () => {
    const total: ProcessResult = { processed: 0, published: 0, failed: 0 };
    try {
      do {
        rerunRequested = false;
        const r = await runOnce(now);
        total.processed += r.processed;
        total.published += r.published;
        total.failed += r.failed;
      } while (rerunRequested);
      return total;
    } finally {
      running = null;
    }
  })();
  return running;
}
