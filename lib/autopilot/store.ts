import { z } from "zod";
import { getDb, newId, nowIso } from "../db";
import { HttpError } from "../api";
import type {
  ApDraft,
  ApDraftRow,
  ApRun,
  ApSource,
  ApSourceParams,
  ApSourceRow,
  ApTemplate,
  ApTemplateRow,
  Autopilot,
  AutopilotRow,
  DraftTexts,
  QcFlag,
} from "./types";
import { AP_PLATFORMS, AP_SOURCE_TYPES } from "./types";
import { safeJsonArray, safeJsonObject } from "./text";
import { isValidTimeZone, parseHm } from "./slots";
import { SOURCE_ADAPTERS } from "./sources";

// AutoPilot data layer. EVERY exported function that takes userId scopes all reads and writes to
// that user (autopilots.user_id), so one user can never see or change another user's autopilots,
// sources, templates, drafts or runs. The HTTP routes are thin wrappers around these.

// ---------- validation ----------

/**
 * zod 4's .partial() still applies .default() values, so a PATCH of { status } would reset every
 * other field. Keep only the keys the client actually sent.
 */
function provided<T extends object>(parsed: T, raw: unknown): Partial<T> {
  const keys = raw && typeof raw === "object" ? new Set(Object.keys(raw)) : new Set<string>();
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => keys.has(k))) as Partial<T>;
}

const terms = z.array(z.string().trim().min(1).max(100)).max(100);
const hm = z.string().refine((s) => parseHm(s) !== null, "Use HH:MM (24-hour)");

export const autopilotInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  niche_description: z.string().max(1000).default(""),
  keywords: terms.default([]),
  region_terms: terms.default([]),
  banned_terms: terms.default([]),
  language: z.enum(["bn", "en", "both"]).default("en"),
  timezone: z.string().refine(isValidTimeZone, "Unknown time zone").default("Asia/Dhaka"),
  frequency_minutes: z.number().int().min(15).max(1440).default(120),
  window_start: hm.default("08:00"),
  window_end: hm.default("23:00"),
  daily_cap: z.number().int().min(1).max(48).default(12),
  min_gap_minutes: z.number().int().min(0).max(1440).default(60),
  // Phase 1: only manual exists. assisted/full_auto are accepted later (Phase 3).
  approval_mode: z.literal("manual").default("manual"),
  auto_threshold: z.number().int().min(0).max(100).default(85),
  max_age_hours: z.number().int().min(1).max(720).default(48),
  min_score: z.number().int().min(0).max(100).default(30),
  ai_daily_cap: z.number().int().min(0).max(1000).default(200),
  account_ids: z.array(z.string().min(1).max(100)).max(50).default([]),
  status: z.enum(["active", "paused"]).default("active"),
});
export type AutopilotInput = z.input<typeof autopilotInputSchema>;
export const autopilotPatchSchema = autopilotInputSchema.partial();

const paramsSchema = z
  .object({
    hl: z.string().max(20).optional(),
    gl: z.string().max(10).optional(),
    ceid: z.string().max(30).optional(),
    timespan: z.string().max(20).optional(),
    maxrecords: z.number().int().min(1).max(250).optional(),
  })
  .strip();

export const sourceInputSchema = z.object({
  type: z.enum(AP_SOURCE_TYPES as [string, ...string[]]),
  label: z.string().trim().max(200).default(""),
  url: z.string().trim().max(2000).nullable().optional(),
  query: z.string().trim().max(500).nullable().optional(),
  params: paramsSchema.default({}),
  interval_minutes: z.number().int().min(15).max(1440).default(15),
  enabled: z.boolean().default(true),
});
export type SourceInput = z.input<typeof sourceInputSchema>;
export const sourcePatchSchema = sourceInputSchema.partial();

export const templateInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  platform: z.enum(["all", ...AP_PLATFORMS] as [string, ...string[]]).default("all"),
  structure: z.string().trim().min(1).max(4000),
  tone_notes: z.string().max(1000).default(""),
  hashtag_rules: z.string().max(500).default(""),
  enabled: z.boolean().default(true),
});
export type TemplateInput = z.input<typeof templateInputSchema>;
export const templatePatchSchema = templateInputSchema.partial();

// ---------- mapping ----------

export function toAutopilot(r: AutopilotRow): Autopilot {
  return {
    id: r.id,
    name: r.name,
    niche_description: r.niche_description,
    keywords: safeJsonArray(r.keywords_json),
    region_terms: safeJsonArray(r.region_terms_json),
    banned_terms: safeJsonArray(r.banned_terms_json),
    language: r.language,
    timezone: r.timezone,
    frequency_minutes: r.frequency_minutes,
    window_start: r.window_start,
    window_end: r.window_end,
    daily_cap: r.daily_cap,
    min_gap_minutes: r.min_gap_minutes,
    approval_mode: r.approval_mode,
    auto_threshold: r.auto_threshold,
    max_age_hours: r.max_age_hours,
    min_score: r.min_score,
    ai_daily_cap: r.ai_daily_cap,
    account_ids: safeJsonArray(r.account_ids_json),
    status: r.status,
    paused_reason: r.paused_reason,
    last_run_at: r.last_run_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function toSource(r: ApSourceRow): ApSource {
  return {
    id: r.id,
    autopilot_id: r.autopilot_id,
    type: r.type,
    label: r.label,
    url: r.url,
    query: r.query,
    params: safeJsonObject<ApSourceParams>(r.params_json),
    interval_minutes: r.interval_minutes,
    enabled: !!r.enabled,
    last_fetched_at: r.last_fetched_at,
    last_ok_at: r.last_ok_at,
    last_error: r.last_error,
    error_count: r.error_count,
    item_count: r.item_count,
    created_at: r.created_at,
  };
}

export function toTemplate(r: ApTemplateRow): ApTemplate {
  return {
    id: r.id,
    autopilot_id: r.autopilot_id,
    name: r.name,
    platform: r.platform,
    structure: r.structure,
    tone_notes: r.tone_notes,
    hashtag_rules: r.hashtag_rules,
    enabled: !!r.enabled,
    last_used_at: r.last_used_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ---------- autopilots ----------

export function maxAutopilotsPerUser(): number {
  const n = Number(process.env.AUTOPILOT_MAX_PER_USER);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 10;
}

export function getAutopilotRow(userId: string, id: string): AutopilotRow | undefined {
  return getDb().prepare("SELECT * FROM autopilots WHERE id = ? AND user_id = ?").get(id, userId) as AutopilotRow | undefined;
}

export function requireAutopilot(userId: string, id: string): AutopilotRow {
  const r = getAutopilotRow(userId, id);
  if (!r) throw new HttpError(404, "Autopilot not found");
  return r;
}

export function listAutopilots(userId: string): Autopilot[] {
  const rows = getDb().prepare("SELECT * FROM autopilots WHERE user_id = ? ORDER BY created_at").all(userId) as AutopilotRow[];
  return rows.map(toAutopilot);
}

/** Only the user's own connected Facebook / Instagram / LinkedIn accounts may be targets. */
function checkAccounts(userId: string, ids: string[]): string[] {
  const unique = [...new Set(ids)];
  if (!unique.length) return unique;
  const stmt = getDb().prepare("SELECT platform FROM social_accounts WHERE id = ? AND user_id = ?");
  for (const id of unique) {
    const a = stmt.get(id, userId) as { platform: string } | undefined;
    if (!a) throw new HttpError(400, "One of the selected accounts was not found");
    if (!(AP_PLATFORMS as string[]).includes(a.platform)) {
      throw new HttpError(400, `AutoPilot posts to Facebook, Instagram and LinkedIn only (not ${a.platform})`);
    }
  }
  return unique;
}

function checkWindow(start: string, end: string): void {
  const s = parseHm(start)!;
  const e = parseHm(end)!;
  if (s.hh * 60 + s.mm >= e.hh * 60 + e.mm) throw new HttpError(400, "Posting window must end after it starts");
}

export function createAutopilot(
  userId: string,
  raw: AutopilotInput & { sources?: SourceInput[]; templates?: TemplateInput[] },
): Autopilot {
  const input = autopilotInputSchema.parse(raw);
  checkWindow(input.window_start, input.window_end);
  const count = (getDb().prepare("SELECT COUNT(*) AS n FROM autopilots WHERE user_id = ?").get(userId) as { n: number }).n;
  if (count >= maxAutopilotsPerUser()) {
    throw new HttpError(409, `You can have at most ${maxAutopilotsPerUser()} autopilots (AUTOPILOT_MAX_PER_USER)`);
  }
  const accounts = checkAccounts(userId, input.account_ids);
  const sources = z.array(sourceInputSchema).max(50).parse(raw.sources ?? []);
  const templates = z.array(templateInputSchema).max(30).parse(raw.templates ?? []);
  for (const s of sources) validateSourceConfig(s);
  const db = getDb();
  const id = newId("ap_");
  const ts = nowIso();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO autopilots (id, user_id, name, niche_description, keywords_json, region_terms_json, banned_terms_json,
         language, timezone, frequency_minutes, window_start, window_end, daily_cap, min_gap_minutes, approval_mode,
         auto_threshold, max_age_hours, min_score, ai_daily_cap, account_ids_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, userId, input.name, input.niche_description, JSON.stringify(input.keywords), JSON.stringify(input.region_terms),
      JSON.stringify(input.banned_terms), input.language, input.timezone, input.frequency_minutes, input.window_start,
      input.window_end, input.daily_cap, input.min_gap_minutes, input.approval_mode, input.auto_threshold,
      input.max_age_hours, input.min_score, input.ai_daily_cap, JSON.stringify(accounts), input.status, ts, ts,
    );
    for (const s of sources) insertSource(userId, id, s);
    for (const t of templates) insertTemplate(userId, id, t);
  })();
  return toAutopilot(requireAutopilot(userId, id));
}

export function updateAutopilot(userId: string, id: string, raw: Partial<AutopilotInput>): Autopilot {
  const cur = toAutopilot(requireAutopilot(userId, id));
  const patch = provided(autopilotPatchSchema.parse(raw), raw);
  const m = { ...cur, ...patch };
  checkWindow(m.window_start, m.window_end);
  const accounts = patch.account_ids ? checkAccounts(userId, patch.account_ids) : cur.account_ids;
  // Resuming clears the pause reason (e.g. after the AI daily cap or an expired account).
  const pausedReason =
    patch.status === "active" ? null : patch.status === "paused" && cur.status !== "paused" ? "Paused by you" : cur.paused_reason;
  getDb()
    .prepare(
      `UPDATE autopilots SET name = ?, niche_description = ?, keywords_json = ?, region_terms_json = ?, banned_terms_json = ?,
         language = ?, timezone = ?, frequency_minutes = ?, window_start = ?, window_end = ?, daily_cap = ?,
         min_gap_minutes = ?, approval_mode = ?, auto_threshold = ?, max_age_hours = ?, min_score = ?, ai_daily_cap = ?,
         account_ids_json = ?, status = ?, paused_reason = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(
      m.name, m.niche_description, JSON.stringify(m.keywords), JSON.stringify(m.region_terms), JSON.stringify(m.banned_terms),
      m.language, m.timezone, m.frequency_minutes, m.window_start, m.window_end, m.daily_cap, m.min_gap_minutes,
      m.approval_mode, m.auto_threshold, m.max_age_hours, m.min_score, m.ai_daily_cap, JSON.stringify(accounts), m.status,
      pausedReason, nowIso(), id, userId,
    );
  return toAutopilot(requireAutopilot(userId, id));
}

/** Deletes the autopilot and its ap_ rows. Posts already in the queue stay (they're normal posts). */
export function deleteAutopilot(userId: string, id: string): boolean {
  return getDb().prepare("DELETE FROM autopilots WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

/** System use (worker): pause with a reason. */
export function pauseAutopilotSystem(id: string, reason: string): void {
  getDb().prepare("UPDATE autopilots SET status = 'paused', paused_reason = ?, updated_at = ? WHERE id = ?").run(reason, nowIso(), id);
}

// ---------- global pause ----------

export function isGloballyPaused(userId: string): boolean {
  const r = getDb().prepare("SELECT paused FROM ap_settings WHERE user_id = ?").get(userId) as { paused: number } | undefined;
  return !!r?.paused;
}

export function setGlobalPause(userId: string, paused: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO ap_settings (user_id, paused, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET paused = excluded.paused, updated_at = excluded.updated_at`,
    )
    .run(userId, paused ? 1 : 0, nowIso());
}

// ---------- sources ----------

export function validateSourceConfig(s: { type: string; url?: string | null; query?: string | null; params?: ApSourceParams }): void {
  const adapter = SOURCE_ADAPTERS[s.type as keyof typeof SOURCE_ADAPTERS];
  if (!adapter) throw new HttpError(400, `Unknown source type ${s.type}`);
  const err = adapter.validate({ type: s.type as ApSource["type"], url: s.url, query: s.query, params: s.params });
  if (err) throw new HttpError(400, err);
}

function insertSource(userId: string, autopilotId: string, s: z.output<typeof sourceInputSchema>): string {
  const id = newId("src_");
  const label = s.label || (s.type === "rss" ? safeHost(s.url ?? "") : `${SOURCE_ADAPTERS[s.type as ApSource["type"]].label}: ${s.query ?? ""}`);
  getDb()
    .prepare(
      `INSERT INTO ap_sources (id, autopilot_id, user_id, type, label, url, query, params_json, interval_minutes, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id, autopilotId, userId, s.type, label.slice(0, 200), s.type === "rss" ? s.url ?? null : null,
      s.type === "rss" ? null : s.query ?? null, JSON.stringify(s.params ?? {}), s.interval_minutes, s.enabled ? 1 : 0, nowIso(),
    );
  return id;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 60);
  }
}

export function listSources(userId: string, autopilotId: string): ApSource[] {
  requireAutopilot(userId, autopilotId);
  const rows = getDb()
    .prepare("SELECT * FROM ap_sources WHERE autopilot_id = ? AND user_id = ? ORDER BY created_at")
    .all(autopilotId, userId) as ApSourceRow[];
  return rows.map(toSource);
}

export function addSource(userId: string, autopilotId: string, raw: SourceInput): ApSource {
  requireAutopilot(userId, autopilotId);
  const s = sourceInputSchema.parse(raw);
  validateSourceConfig(s);
  const id = insertSource(userId, autopilotId, s);
  return toSource(getDb().prepare("SELECT * FROM ap_sources WHERE id = ?").get(id) as ApSourceRow);
}

function requireSourceRow(userId: string, autopilotId: string, sourceId: string): ApSourceRow {
  const r = getDb()
    .prepare("SELECT * FROM ap_sources WHERE id = ? AND autopilot_id = ? AND user_id = ?")
    .get(sourceId, autopilotId, userId) as ApSourceRow | undefined;
  if (!r) throw new HttpError(404, "Source not found");
  return r;
}

export function updateSource(userId: string, autopilotId: string, sourceId: string, raw: Partial<SourceInput>): ApSource {
  const cur = toSource(requireSourceRow(userId, autopilotId, sourceId));
  const patch = provided(sourcePatchSchema.parse(raw), raw);
  const m = { ...cur, ...patch, params: patch.params ?? cur.params };
  validateSourceConfig(m);
  // Re-enabling a source that auto-paused after failures resets its error count.
  const resetErrors = patch.enabled === true && !cur.enabled;
  getDb()
    .prepare(
      `UPDATE ap_sources SET type = ?, label = ?, url = ?, query = ?, params_json = ?, interval_minutes = ?, enabled = ?,
         error_count = CASE WHEN ? THEN 0 ELSE error_count END,
         last_error = CASE WHEN ? THEN NULL ELSE last_error END
       WHERE id = ? AND user_id = ?`,
    )
    .run(
      m.type, m.label, m.type === "rss" ? m.url ?? null : null, m.type === "rss" ? null : m.query ?? null,
      JSON.stringify(m.params ?? {}), m.interval_minutes, m.enabled ? 1 : 0, resetErrors ? 1 : 0, resetErrors ? 1 : 0,
      sourceId, userId,
    );
  return toSource(requireSourceRow(userId, autopilotId, sourceId));
}

export function deleteSource(userId: string, autopilotId: string, sourceId: string): boolean {
  return (
    getDb().prepare("DELETE FROM ap_sources WHERE id = ? AND autopilot_id = ? AND user_id = ?").run(sourceId, autopilotId, userId)
      .changes > 0
  );
}

// ---------- templates ----------

function insertTemplate(userId: string, autopilotId: string, t: z.output<typeof templateInputSchema>): string {
  const id = newId("tpl_");
  const ts = nowIso();
  getDb()
    .prepare(
      `INSERT INTO ap_templates (id, autopilot_id, user_id, name, platform, structure, tone_notes, hashtag_rules, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, autopilotId, userId, t.name, t.platform, t.structure, t.tone_notes, t.hashtag_rules, t.enabled ? 1 : 0, ts, ts);
  return id;
}

export function listTemplates(userId: string, autopilotId: string): ApTemplate[] {
  requireAutopilot(userId, autopilotId);
  const rows = getDb()
    .prepare("SELECT * FROM ap_templates WHERE autopilot_id = ? AND user_id = ? ORDER BY created_at")
    .all(autopilotId, userId) as ApTemplateRow[];
  return rows.map(toTemplate);
}

export function addTemplate(userId: string, autopilotId: string, raw: TemplateInput): ApTemplate {
  requireAutopilot(userId, autopilotId);
  const id = insertTemplate(userId, autopilotId, templateInputSchema.parse(raw));
  return toTemplate(getDb().prepare("SELECT * FROM ap_templates WHERE id = ?").get(id) as ApTemplateRow);
}

function requireTemplateRow(userId: string, autopilotId: string, templateId: string): ApTemplateRow {
  const r = getDb()
    .prepare("SELECT * FROM ap_templates WHERE id = ? AND autopilot_id = ? AND user_id = ?")
    .get(templateId, autopilotId, userId) as ApTemplateRow | undefined;
  if (!r) throw new HttpError(404, "Template not found");
  return r;
}

export function updateTemplate(userId: string, autopilotId: string, templateId: string, raw: Partial<TemplateInput>): ApTemplate {
  const cur = toTemplate(requireTemplateRow(userId, autopilotId, templateId));
  const m = { ...cur, ...provided(templatePatchSchema.parse(raw), raw) };
  getDb()
    .prepare(
      `UPDATE ap_templates SET name = ?, platform = ?, structure = ?, tone_notes = ?, hashtag_rules = ?, enabled = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(m.name, m.platform, m.structure, m.tone_notes, m.hashtag_rules, m.enabled ? 1 : 0, nowIso(), templateId, userId);
  return toTemplate(requireTemplateRow(userId, autopilotId, templateId));
}

export function deleteTemplate(userId: string, autopilotId: string, templateId: string): boolean {
  return (
    getDb().prepare("DELETE FROM ap_templates WHERE id = ? AND autopilot_id = ? AND user_id = ?").run(templateId, autopilotId, userId)
      .changes > 0
  );
}

// ---------- drafts ----------

function draftFromRow(r: ApDraftRow & { template_name?: string | null; post_status?: string | null }): ApDraft {
  const db = getDb();
  const image = r.image_media_id
    ? ((db.prepare("SELECT id, public_url, mime_type FROM media WHERE id = ? AND user_id = ?").get(r.image_media_id, r.user_id) as
        | ApDraft["image"]
        | undefined) ?? null)
    : null;
  const related = r.topic_id
    ? (db
        .prepare(
          `SELECT title, url, publisher FROM ap_items WHERE topic_id = ? AND (? IS NULL OR id <> ?)
           ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT 8`,
        )
        .all(r.topic_id, r.item_id, r.item_id) as ApDraft["related"])
    : [];
  let flags: QcFlag[] = [];
  try {
    const v = JSON.parse(r.qc_flags_json) as unknown;
    if (Array.isArray(v)) flags = v as QcFlag[];
  } catch {
    /* ignore */
  }
  return {
    id: r.id,
    autopilot_id: r.autopilot_id,
    topic_id: r.topic_id,
    template_id: r.template_id,
    template_name: r.template_name ?? null,
    headline: r.headline,
    source_url: r.source_url,
    source_name: r.source_name,
    source_summary: r.source_summary,
    related,
    texts: safeJsonObject<DraftTexts>(r.texts_json) as DraftTexts,
    image,
    qc_score: r.qc_score,
    qc_flags: flags,
    status: r.status,
    slot_at: r.slot_at,
    generator: r.generator,
    reviewed_at: r.reviewed_at,
    reject_reason: r.reject_reason,
    post_id: r.post_id,
    post_status: r.post_status ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const DRAFT_SELECT = `SELECT d.*, t.name AS template_name, p.status AS post_status FROM ap_drafts d
  LEFT JOIN ap_templates t ON t.id = d.template_id
  LEFT JOIN posts p ON p.id = d.post_id`;

export function listDrafts(userId: string, autopilotId: string, status?: string | null, limit = 100): ApDraft[] {
  requireAutopilot(userId, autopilotId);
  const where = ["d.autopilot_id = ?", "d.user_id = ?"];
  const args: (string | number)[] = [autopilotId, userId];
  if (status) {
    where.push("d.status = ?");
    args.push(status);
  }
  args.push(Math.min(500, Math.max(1, limit)));
  const rows = getDb()
    .prepare(`${DRAFT_SELECT} WHERE ${where.join(" AND ")} ORDER BY d.created_at DESC LIMIT ?`)
    .all(...args) as (ApDraftRow & { template_name: string | null; post_status: string | null })[];
  return rows.map(draftFromRow);
}

export function getDraftRow(userId: string, draftId: string): ApDraftRow | undefined {
  return getDb().prepare("SELECT * FROM ap_drafts WHERE id = ? AND user_id = ?").get(draftId, userId) as ApDraftRow | undefined;
}

export function getDraft(userId: string, draftId: string): ApDraft | null {
  const r = getDb().prepare(`${DRAFT_SELECT} WHERE d.id = ? AND d.user_id = ?`).get(draftId, userId) as
    | (ApDraftRow & { template_name: string | null; post_status: string | null })
    | undefined;
  return r ? draftFromRow(r) : null;
}

export function requireDraftRow(userId: string, draftId: string): ApDraftRow {
  const r = getDraftRow(userId, draftId);
  if (!r) throw new HttpError(404, "Draft not found");
  return r;
}

export const draftEditSchema = z.object({
  texts: z
    .object({
      facebook: z.string().max(63206).optional(),
      instagram: z.string().max(2200).optional(),
      linkedin: z.string().max(3000).optional(),
    })
    .strip()
    .optional(),
  image_media_id: z.string().min(1).max(100).nullable().optional(),
});

/** Edit texts / attach an image. Only while the draft is in review. */
export function editDraft(userId: string, draftId: string, raw: z.input<typeof draftEditSchema>): ApDraft {
  const d = requireDraftRow(userId, draftId);
  if (d.status !== "in_review") throw new HttpError(409, "Only drafts in review can be edited");
  const patch = draftEditSchema.parse(raw);
  const texts = { ...(safeJsonObject<DraftTexts>(d.texts_json) as DraftTexts), ...(patch.texts ?? {}) };
  let image = d.image_media_id;
  if (patch.image_media_id !== undefined) {
    if (patch.image_media_id) {
      const m = getDb().prepare("SELECT mime_type FROM media WHERE id = ? AND user_id = ?").get(patch.image_media_id, userId) as
        | { mime_type: string }
        | undefined;
      if (!m) throw new HttpError(400, "Image not found");
      if (!m.mime_type.startsWith("image/")) throw new HttpError(400, "Attach an image (JPEG for Instagram)");
    }
    image = patch.image_media_id;
  }
  getDb()
    .prepare("UPDATE ap_drafts SET texts_json = ?, image_media_id = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(JSON.stringify(texts), image, nowIso(), draftId, userId);
  return getDraft(userId, draftId)!;
}

export function rejectDraft(userId: string, draftId: string, reason: string): ApDraft {
  const d = requireDraftRow(userId, draftId);
  if (d.status !== "in_review") throw new HttpError(409, "Only drafts in review can be rejected");
  const ts = nowIso();
  getDb()
    .prepare(
      "UPDATE ap_drafts SET status = 'rejected', reject_reason = ?, reviewer_id = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    )
    .run(reason.trim().slice(0, 500) || null, userId, ts, ts, draftId, userId);
  return getDraft(userId, draftId)!;
}

export function inboxCount(userId: string, autopilotId?: string): number {
  const r = autopilotId
    ? getDb().prepare("SELECT COUNT(*) AS n FROM ap_drafts WHERE user_id = ? AND autopilot_id = ? AND status = 'in_review'").get(userId, autopilotId)
    : getDb().prepare("SELECT COUNT(*) AS n FROM ap_drafts WHERE user_id = ? AND status = 'in_review'").get(userId);
  return (r as { n: number }).n;
}

// ---------- runs ----------

export function listRuns(userId: string, autopilotId: string, limit = 50): ApRun[] {
  requireAutopilot(userId, autopilotId);
  const rows = getDb()
    .prepare("SELECT * FROM ap_runs WHERE autopilot_id = ? AND user_id = ? ORDER BY started_at DESC LIMIT ?")
    .all(autopilotId, userId, Math.min(200, limit)) as (Omit<ApRun, "counts"> & { counts_json: string })[];
  return rows.map(({ counts_json, ...r }) => ({ ...r, counts: safeJsonObject<Record<string, number>>(counts_json) as Record<string, number> }));
}
