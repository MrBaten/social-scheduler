import { z } from "zod";
import { getDb, nowIso } from "../db";
import { HttpError } from "../api";
import { createPost } from "../posts";
import { getMediaItems } from "../media";
import { validateForPlatform } from "../platforms";
import type { PostWithTargets, SocialAccountRow } from "../types";
import type { ApDraft, ApPlatform, DraftTexts } from "./types";
import { AP_PLATFORMS } from "./types";
import { getDraft, requireAutopilot, requireDraftRow, toAutopilot } from "./store";
import { safeJsonObject } from "./text";
import { nextFreeSlot, type SlotConfig } from "./slots";

// Step 8, the hand-off. Approving a draft creates a NORMAL post through lib/posts.createPost (same
// validation as Compose), then marks it origin = 'autopilot'. From there the existing scheduler
// publishes and retries it exactly like a manual post. AutoPilot never calls a platform API.

export const approveSchema = z.object({
  /** slot: the draft's slot, or the next free slot (default) · now · custom time · queue_draft: unscheduled draft in Queue */
  when: z.enum(["slot", "now", "custom", "queue_draft"]).default("slot"),
  scheduled_at: z.string().max(100).optional(),
  /** Limit to some platforms; default = every platform the autopilot posts to. */
  platforms: z.array(z.enum(AP_PLATFORMS as [ApPlatform, ...ApPlatform[]])).optional(),
});
export type ApproveInput = z.input<typeof approveSchema>;

export interface ApproveResult {
  draft: ApDraft;
  post: PostWithTargets;
  /** Accounts left out, with the reason (e.g. Instagram without an image). */
  skipped: { account: string; platform: string; reason: string }[];
}

/** Earliest time an approved post may be scheduled for (gives the reviewer a moment to undo). */
const MIN_LEAD_MS = 2 * 60_000;

export function slotConfigOf(ap: { timezone: string; window_start: string; window_end: string; frequency_minutes: number; min_gap_minutes: number; daily_cap: number }): SlotConfig {
  return {
    timezone: ap.timezone,
    window_start: ap.window_start,
    window_end: ap.window_end,
    frequency_minutes: ap.frequency_minutes,
    min_gap_minutes: ap.min_gap_minutes,
    daily_cap: ap.daily_cap,
  };
}

/** Scheduled times of this autopilot's posts still in the queue (for min-gap and daily cap). */
export function takenTimes(autopilotId: string, since: Date): Date[] {
  const rows = getDb()
    .prepare(
      `SELECT p.scheduled_at FROM posts p JOIN ap_drafts d ON d.id = p.ap_draft_id
       WHERE d.autopilot_id = ? AND p.origin = 'autopilot' AND p.scheduled_at IS NOT NULL AND p.scheduled_at >= ?
         AND p.status <> 'failed'`,
    )
    .all(autopilotId, since.toISOString()) as { scheduled_at: string }[];
  return rows.map((r) => new Date(r.scheduled_at));
}

export function approveDraft(userId: string, draftId: string, raw: ApproveInput = {}, now: Date = new Date()): ApproveResult {
  const opts = approveSchema.parse(raw);
  const d = requireDraftRow(userId, draftId);
  if (d.status !== "in_review") throw new HttpError(409, "This draft was already reviewed");
  const ap = toAutopilot(requireAutopilot(userId, d.autopilot_id));
  const texts = safeJsonObject<DraftTexts>(d.texts_json) as DraftTexts;
  const db = getDb();

  // Accounts: only the user's own, only the platforms AutoPilot writes for.
  const acctStmt = db.prepare("SELECT * FROM social_accounts WHERE id = ? AND user_id = ?");
  const accounts = ap.account_ids
    .map((id) => acctStmt.get(id, userId) as SocialAccountRow | undefined)
    .filter((a): a is SocialAccountRow => !!a && (AP_PLATFORMS as string[]).includes(a.platform));
  if (!accounts.length) throw new HttpError(400, "This autopilot has no connected accounts to post to. Add them in Settings.");

  const image = d.image_media_id
    ? (db.prepare("SELECT id, mime_type FROM media WHERE id = ? AND user_id = ?").get(d.image_media_id, userId) as
        | { id: string; mime_type: string }
        | undefined)
    : undefined;

  const skipped: ApproveResult["skipped"] = [];
  const targets: { social_account_id: string; text_override: string }[] = [];
  const mediaItems = image ? getMediaItems(userId, [image.id]) : [];
  for (const a of accounts) {
    const p = a.platform as ApPlatform;
    if (opts.platforms && !opts.platforms.includes(p)) continue;
    const text = texts[p]?.trim();
    if (!text) {
      skipped.push({ account: a.display_name, platform: p, reason: "No text for this platform" });
      continue;
    }
    if (p === "instagram" && !image) {
      skipped.push({ account: a.display_name, platform: p, reason: "Instagram needs an image: attach one to include it" });
      continue;
    }
    // The image is shared by every platform of the post. If THIS platform can't take it (e.g.
    // Instagram: JPEG only; LinkedIn: no WebP) but would be fine without it, leave this platform
    // out instead of failing the whole post. Other errors (e.g. text too long) still fail below.
    if (mediaItems.length) {
      const withImage = validateForPlatform(p, { text, media: mediaItems, options: {} });
      const imageIsTheProblem =
        withImage.length > 0 &&
        // Instagram can't post without media at all, so any image error is the image's fault.
        (p === "instagram" || validateForPlatform(p, { text, media: [], options: {} }).length === 0);
      if (imageIsTheProblem) {
        skipped.push({ account: a.display_name, platform: p, reason: withImage.join(" ") });
        continue;
      }
    }
    targets.push({ social_account_id: a.id, text_override: text });
  }
  if (!targets.length) {
    throw new HttpError(400, skipped.length ? `Nothing to post: ${skipped.map((s) => `${s.platform}: ${s.reason}`).join("; ")}` : "Nothing to post");
  }

  // When.
  let scheduledAt: string | null;
  const earliest = new Date(now.getTime() + MIN_LEAD_MS);
  if (opts.when === "queue_draft") scheduledAt = null;
  else if (opts.when === "now") scheduledAt = now.toISOString();
  else if (opts.when === "custom") {
    const t = Date.parse(opts.scheduled_at ?? "");
    if (Number.isNaN(t)) throw new HttpError(400, "Pick a valid date and time");
    if (t < now.getTime() - 60_000) throw new HttpError(400, "That time is in the past");
    scheduledAt = new Date(t).toISOString();
  } else {
    const cfg = slotConfigOf(ap);
    const taken = takenTimes(ap.id, new Date(now.getTime() - 86_400_000));
    const gap = ap.min_gap_minutes * 60_000;
    const own = d.slot_at ? new Date(d.slot_at) : null;
    if (own && own.getTime() >= earliest.getTime() && !taken.some((t) => Math.abs(t.getTime() - own.getTime()) < gap)) {
      scheduledAt = own.toISOString();
    } else {
      const s = nextFreeSlot(earliest, cfg, taken);
      if (!s) throw new HttpError(409, "No free posting slot in the next 7 days (daily cap or posting window). Pick a time instead.");
      scheduledAt = s.toISOString();
    }
  }

  const baseText = texts.facebook?.trim() || targets[0].text_override;
  const mediaIds = image && image.mime_type.startsWith("image/") ? [image.id] : [];

  const post = db.transaction(() => {
    // createPost validates every target with the platform rules and throws PostValidationError (400).
    const created = createPost(userId, { base_text: baseText, media_ids: mediaIds, scheduled_at: scheduledAt, targets });
    db.prepare("UPDATE posts SET origin = 'autopilot', ap_draft_id = ? WHERE id = ? AND user_id = ?").run(d.id, created.id, userId);
    const ts = nowIso();
    const changed = db
      .prepare(
        `UPDATE ap_drafts SET status = ?, post_id = ?, reviewer_id = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'in_review'`,
      )
      .run(scheduledAt ? "scheduled" : "approved", created.id, userId, ts, ts, d.id, userId).changes;
    if (changed !== 1) throw new HttpError(409, "This draft was already reviewed");
    return { ...created, origin: "autopilot" as const, ap_draft_id: d.id };
  }).immediate();

  return { draft: getDraft(userId, draftId)!, post, skipped };
}
