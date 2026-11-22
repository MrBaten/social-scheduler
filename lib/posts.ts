import { z } from "zod";
import { getDb, newId, nowIso } from "./db";
import { HttpError } from "./api";
import { validateForPlatform } from "./platforms";
import { getMediaItems, getPostMediaItems } from "./media";
import type {
  CreatePostInput,
  Platform,
  PostRow,
  PostStatus,
  PostTargetRow,
  PostWithTargets,
  PublishContent,
  SocialAccountRow,
  TargetOptions,
} from "./types";

// Data layer for posts. Every exported function that takes a userId scopes ALL reads and
// writes to that user, so the HTTP routes are thin wrappers and these are unit-testable.

/** "Now" may be sent by the client a little late; accept scheduled_at up to this far in the past. */
const PAST_GRACE_MS = 5 * 60_000;

// ---------- validation schemas ----------

export const targetOptionsSchema = z
  .object({
    title: z.string().max(500).optional(),
    privacy: z.enum(["public", "private", "unlisted", "self_only", "friends"]).optional(),
    ig_type: z.enum(["feed", "reel", "story"]).optional(),
    link: z.string().max(2000).optional(),
  })
  .strip();

export const targetInputSchema = z.object({
  social_account_id: z.string().min(1).max(100),
  text_override: z.string().max(20_000).nullable().optional(),
  options: targetOptionsSchema.optional(),
});

export const createPostSchema = z.object({
  base_text: z.string().max(20_000),
  media_ids: z.array(z.string().min(1).max(100)).max(20).default([]),
  scheduled_at: z.string().max(100).nullable(),
  targets: z.array(targetInputSchema).max(50),
});

/** PATCH body: any subset of CreatePostInput; missing fields keep their current value. */
export const updatePostSchema = createPostSchema.partial();

export type UpdatePostInput = Partial<CreatePostInput>;

/** 400 with `{ error, errors: { [social_account_id | "_post"]: string[] } }`. */
export class PostValidationError extends HttpError {
  errors: Record<string, string[]>;
  constructor(errors: Record<string, string[]>) {
    super(400, Object.values(errors).flat()[0] ?? "Validation failed", { errors });
    this.errors = errors;
  }
}

// ---------- reads ----------

type TargetWithName = PostTargetRow & { account_display_name: string };

const TARGET_COLS = `t.id, t.post_id, t.social_account_id, t.platform, t.text_override, t.options_json,
  t.status, t.attempts, t.next_attempt_at, t.last_error, t.platform_post_id, t.platform_post_url,
  t.published_at`;

function loadPostWithTargets(post: PostRow): PostWithTargets {
  const db = getDb();
  const media = db
    .prepare(
      `SELECT m.id, m.public_url, m.mime_type, m.filename FROM post_media pm
       JOIN media m ON m.id = pm.media_id WHERE pm.post_id = ? ORDER BY pm.position`,
    )
    .all(post.id) as PostWithTargets["media"];
  const targets = db
    .prepare(
      `SELECT ${TARGET_COLS}, COALESCE(a.display_name, '') AS account_display_name
       FROM post_targets t LEFT JOIN social_accounts a ON a.id = t.social_account_id
       WHERE t.post_id = ? ORDER BY t.rowid`,
    )
    .all(post.id) as TargetWithName[];
  return { ...post, media, targets };
}

function getPostRow(userId: string, postId: string): PostRow | undefined {
  return getDb().prepare("SELECT * FROM posts WHERE id = ? AND user_id = ?").get(postId, userId) as
    | PostRow
    | undefined;
}

function requirePostRow(userId: string, postId: string): PostRow {
  const row = getPostRow(userId, postId);
  if (!row) throw new HttpError(404, "Post not found");
  return row;
}

export function getPost(userId: string, postId: string): PostWithTargets | null {
  const row = getPostRow(userId, postId);
  return row ? loadPostWithTargets(row) : null;
}

/**
 * Posts of `userId`. With from/to (ISO), filters on COALESCE(scheduled_at, created_at) in
 * [from, to), so drafts show up on the day they were created. Ordered by that time ascending.
 */
export function listPosts(userId: string, from?: string | null, to?: string | null): PostWithTargets[] {
  const where = ["user_id = ?"];
  const args: string[] = [userId];
  if (from) {
    where.push("COALESCE(scheduled_at, created_at) >= ?");
    args.push(normalizeIso(from, "from"));
  }
  if (to) {
    where.push("COALESCE(scheduled_at, created_at) < ?");
    args.push(normalizeIso(to, "to"));
  }
  const rows = getDb()
    .prepare(
      `SELECT * FROM posts WHERE ${where.join(" AND ")}
       ORDER BY COALESCE(scheduled_at, created_at) ASC, created_at ASC LIMIT 1000`,
    )
    .all(...args) as PostRow[];
  return rows.map(loadPostWithTargets);
}

function normalizeIso(s: string, field: string): string {
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new HttpError(400, `Invalid ${field} date`);
  return new Date(t).toISOString();
}

// ---------- validation ----------

function parseOptions(json: string): TargetOptions {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" ? (v as TargetOptions) : {};
  } catch {
    return {};
  }
}

interface ResolvedTarget {
  social_account_id: string;
  platform: Platform;
  text_override: string | null;
  options: TargetOptions;
}

interface ResolvedPost {
  base_text: string;
  media_ids: string[];
  scheduled_at: string | null;
  targets: ResolvedTarget[];
}

/**
 * Validate input for `userId` and resolve accounts/platforms. Throws PostValidationError.
 * Platform content rules are skipped for drafts (a draft may be incomplete) and enforced as
 * soon as the post is scheduled.
 */
function resolveAndValidate(userId: string, input: CreatePostInput, opts: { now?: Date } = {}): ResolvedPost {
  const errors: Record<string, string[]> = {};
  const addErr = (key: string, msg: string) => (errors[key] ??= []).push(msg);
  const now = (opts.now ?? new Date()).getTime();

  // scheduled_at
  let scheduledAt: string | null = null;
  if (input.scheduled_at !== null && input.scheduled_at !== undefined && input.scheduled_at !== "") {
    const t = Date.parse(input.scheduled_at);
    if (Number.isNaN(t)) addErr("_post", "scheduled_at must be a valid ISO date");
    else if (t < now - PAST_GRACE_MS) addErr("_post", "scheduled_at is in the past");
    else scheduledAt = new Date(t).toISOString();
  }
  const isDraft = input.scheduled_at === null || input.scheduled_at === undefined || input.scheduled_at === "";

  // media (dedupe, must belong to user, keep order)
  const mediaIds = [...new Set(input.media_ids ?? [])];
  const media = getMediaItems(userId, mediaIds);
  if (media.length !== mediaIds.length) addErr("_post", "One or more media files were not found");

  // targets (dedupe by account; first occurrence wins)
  const seen = new Set<string>();
  const targetsIn = (input.targets ?? []).filter((t) => {
    if (seen.has(t.social_account_id)) return false;
    seen.add(t.social_account_id);
    return true;
  });
  if (!isDraft && targetsIn.length === 0) addErr("_post", "Select at least one account");

  const acctStmt = getDb().prepare("SELECT * FROM social_accounts WHERE id = ? AND user_id = ?");
  const resolved: ResolvedTarget[] = [];
  for (const t of targetsIn) {
    const acct = acctStmt.get(t.social_account_id, userId) as SocialAccountRow | undefined;
    if (!acct) {
      addErr(t.social_account_id, "Account not found");
      continue;
    }
    const target: ResolvedTarget = {
      social_account_id: acct.id,
      platform: acct.platform,
      text_override: t.text_override ?? null,
      options: t.options ?? {},
    };
    resolved.push(target);
    if (isDraft) continue;
    if (acct.status === "expired") addErr(acct.id, "Account connection expired. Reconnect it on the Accounts page.");
    const content: PublishContent = {
      text: target.text_override ?? input.base_text,
      media,
      options: target.options,
    };
    for (const e of validateForPlatform(acct.platform, content)) addErr(acct.id, e);
  }

  if (Object.keys(errors).length > 0) throw new PostValidationError(errors);
  return { base_text: input.base_text, media_ids: mediaIds, scheduled_at: scheduledAt, targets: resolved };
}

// ---------- writes ----------

function writeChildren(postId: string, p: ResolvedPost): void {
  const db = getDb();
  db.prepare("DELETE FROM post_media WHERE post_id = ?").run(postId);
  db.prepare("DELETE FROM post_targets WHERE post_id = ?").run(postId);
  const insMedia = db.prepare("INSERT INTO post_media (post_id, media_id, position) VALUES (?, ?, ?)");
  p.media_ids.forEach((mid, i) => insMedia.run(postId, mid, i));
  const insTarget = db.prepare(
    `INSERT INTO post_targets (id, post_id, social_account_id, platform, text_override, options_json,
       status, attempts, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
  );
  for (const t of p.targets) {
    insTarget.run(
      newId("t_"),
      postId,
      t.social_account_id,
      t.platform,
      t.text_override,
      JSON.stringify(t.options ?? {}),
      p.scheduled_at,
    );
  }
}

export function createPost(userId: string, rawInput: CreatePostInput): PostWithTargets {
  const input = createPostSchema.parse(rawInput) as CreatePostInput;
  const resolved = resolveAndValidate(userId, input);
  const db = getDb();
  const id = newId("p_");
  const ts = nowIso();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO posts (id, user_id, base_text, scheduled_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, userId, resolved.base_text, resolved.scheduled_at, resolved.scheduled_at ? "scheduled" : "draft", ts, ts);
    writeChildren(id, resolved);
  })();
  return getPost(userId, id)!;
}

function assertEditable(postId: string): void {
  const busy = getDb()
    .prepare("SELECT 1 FROM post_targets WHERE post_id = ? AND status IN ('publishing', 'published') LIMIT 1")
    .get(postId);
  if (busy) throw new HttpError(409, "Post can't be edited after publishing has started");
}

/**
 * Edit a post. Missing fields keep their current value. Targets are rebuilt from scratch
 * (attempts/errors reset), so editing a failed post re-queues it.
 */
export function updatePost(userId: string, postId: string, rawInput: UpdatePostInput): PostWithTargets {
  const patch = updatePostSchema.parse(rawInput) as UpdatePostInput;
  const current = getPost(userId, postId);
  if (!current) throw new HttpError(404, "Post not found");
  assertEditable(postId);

  const merged: CreatePostInput = {
    base_text: patch.base_text ?? current.base_text,
    media_ids: patch.media_ids ?? current.media.map((m) => m.id),
    scheduled_at: patch.scheduled_at !== undefined ? patch.scheduled_at : current.scheduled_at,
    targets:
      patch.targets ??
      current.targets.map((t) => ({
        social_account_id: t.social_account_id,
        text_override: t.text_override,
        options: parseOptions(t.options_json),
      })),
  };
  // An unchanged scheduled_at that has slipped into the past would fail the "not in the past"
  // check; treat it as "now".
  if (patch.scheduled_at === undefined && merged.scheduled_at && Date.parse(merged.scheduled_at) < Date.now()) {
    merged.scheduled_at = nowIso();
  }
  const resolved = resolveAndValidate(userId, merged);
  const db = getDb();
  db.transaction(() => {
    assertEditable(postId); // re-check inside the write transaction (scheduler may have claimed)
    db.prepare("UPDATE posts SET base_text = ?, scheduled_at = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(
      resolved.base_text,
      resolved.scheduled_at,
      resolved.scheduled_at ? "scheduled" : "draft",
      nowIso(),
      postId,
      userId,
    );
    writeChildren(postId, resolved);
  }).immediate();
  recomputePostStatus(postId);
  return getPost(userId, postId)!;
}

export function deletePost(userId: string, postId: string): boolean {
  return getDb().prepare("DELETE FROM posts WHERE id = ? AND user_id = ?").run(postId, userId).changes > 0;
}

/** Failed targets -> pending, due now, attempts reset. */
export function retryFailed(userId: string, postId: string, now: Date = new Date()): PostWithTargets {
  const post = requirePostRow(userId, postId);
  const ts = now.toISOString();
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `UPDATE post_targets SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL, locked_at = NULL
       WHERE post_id = ? AND status = 'failed'`,
    ).run(ts, post.id);
    // A retried draft becomes a post scheduled for now.
    if (!post.scheduled_at) db.prepare("UPDATE posts SET scheduled_at = ? WHERE id = ?").run(ts, post.id);
  })();
  recomputePostStatus(post.id);
  return getPost(userId, postId)!;
}

/**
 * Make every pending target due now. Drafts are validated first (they skipped platform
 * rules when saved). Does NOT run the scheduler; the route triggers processDuePosts().
 */
export function publishNow(userId: string, postId: string, now: Date = new Date()): PostWithTargets {
  const post = getPost(userId, postId);
  if (!post) throw new HttpError(404, "Post not found");
  const pending = post.targets.filter((t) => t.status === "pending");
  if (pending.length === 0) throw new HttpError(409, "Nothing to publish: no pending targets");
  const ts = now.toISOString();
  if (!post.scheduled_at) {
    resolveAndValidate(
      userId,
      {
        base_text: post.base_text,
        media_ids: post.media.map((m) => m.id),
        scheduled_at: ts,
        targets: pending.map((t) => ({
          social_account_id: t.social_account_id,
          text_override: t.text_override,
          options: parseOptions(t.options_json),
        })),
      },
      { now },
    );
  }
  const db = getDb();
  db.transaction(() => {
    db.prepare("UPDATE post_targets SET next_attempt_at = ? WHERE post_id = ? AND status = 'pending'").run(ts, postId);
    db.prepare("UPDATE posts SET scheduled_at = ?, updated_at = ? WHERE id = ?").run(ts, nowIso(), postId);
  })();
  recomputePostStatus(postId);
  return getPost(userId, postId)!;
}

/**
 * Derive post status from its targets:
 * any publishing -> publishing; none pending and all published -> published; all failed ->
 * failed; published+failed mix -> partial; pending targets on a post whose publishing has
 * already started (a pending target waiting for a retry, i.e. attempts > 0, or some targets
 * already published/failed) -> publishing; otherwise scheduled (draft if no scheduled_at).
 */
export function recomputePostStatus(postId: string): PostStatus | null {
  const db = getDb();
  const post = db.prepare("SELECT scheduled_at, status FROM posts WHERE id = ?").get(postId) as
    | { scheduled_at: string | null; status: PostStatus }
    | undefined;
  if (!post) return null;
  const counts = db
    .prepare(
      `SELECT status, COUNT(*) AS n, SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END) AS tried
       FROM post_targets WHERE post_id = ? GROUP BY status`,
    )
    .all(postId) as { status: string; n: number; tried: number }[];
  const c = { pending: 0, publishing: 0, published: 0, failed: 0 } as Record<string, number>;
  let pendingRetrying = 0;
  for (const r of counts) {
    c[r.status] = r.n;
    if (r.status === "pending") pendingRetrying = r.tried ?? 0;
  }
  const total = c.pending + c.publishing + c.published + c.failed;

  let status: PostStatus;
  if (c.publishing > 0) status = "publishing";
  else if (total > 0 && c.pending === 0) {
    if (c.failed === 0) status = "published";
    else if (c.published === 0) status = "failed";
    else status = "partial";
  } else if (c.pending > 0 && (pendingRetrying > 0 || c.published + c.failed > 0)) status = "publishing";
  else status = post.scheduled_at ? "scheduled" : "draft";

  if (status !== post.status) {
    db.prepare("UPDATE posts SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), postId);
  }
  return status;
}

/** Build what an adapter publishes for one target. Used by the scheduler. */
export function buildPublishContent(
  post: { id: string; base_text: string },
  target: { text_override: string | null; options_json: string },
): PublishContent {
  return {
    text: target.text_override ?? post.base_text,
    media: getPostMediaItems(post.id),
    options: parseOptions(target.options_json),
  };
}
