// Browser-side helpers shared by the AutoPilot screens.
import type { ApLanguage, ApPlatform, ApSourceParams, ApSourceType } from "@/lib/autopilot/types";
import { ApiError } from "../api";

export const AP_PLATFORM_LIST: ApPlatform[] = ["facebook", "instagram", "linkedin"];

/** Same limits as lib/platforms/rules.ts. */
export const PLATFORM_LIMITS: Record<ApPlatform, number> = { facebook: 63206, instagram: 2200, linkedin: 3000 };

export const LANGUAGE_LABEL: Record<ApLanguage, string> = { bn: "Bangla", en: "English", both: "Both (Bangla, then English)" };

export const SOURCE_TYPE_LABEL: Record<ApSourceType, string> = {
  rss: "RSS / Atom feed",
  google_news: "Google News search",
  gdelt: "GDELT search",
};

export const TEMPLATE_VARS = ["{headline}", "{summary}", "{source}", "{link}", "{date}"];

/** Editable source row (wizard + Sources page). */
export interface SourceDraft {
  key: string;
  type: ApSourceType;
  label: string;
  url: string;
  query: string;
  params: ApSourceParams;
}

let counter = 0;
export function newKey(): string {
  counter += 1;
  return `k${Date.now().toString(36)}${counter}`;
}

export function emptySource(type: ApSourceType, language: ApLanguage = "en"): SourceDraft {
  return {
    key: newKey(),
    type,
    label: "",
    url: "",
    query: "",
    params: type === "google_news" ? { hl: language === "bn" ? "bn" : "en", gl: "BD" } : type === "gdelt" ? { timespan: "1d" } : {},
  };
}

export function sourcePayload(s: SourceDraft) {
  const params: ApSourceParams = {};
  if (s.type === "google_news") {
    if (s.params.hl) params.hl = s.params.hl;
    if (s.params.gl) params.gl = s.params.gl;
    if (s.params.ceid) params.ceid = s.params.ceid;
  }
  if (s.type === "gdelt") {
    if (s.params.timespan) params.timespan = s.params.timespan;
    if (s.params.maxrecords) params.maxrecords = s.params.maxrecords;
  }
  return {
    type: s.type,
    label: s.label.trim(),
    url: s.type === "rss" ? s.url.trim() : null,
    query: s.type === "rss" ? null : s.query.trim(),
    params,
    interval_minutes: 15,
  };
}

/** Human message from an ApiError, including zod issues. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body as { issues?: { path?: (string | number)[]; message?: string }[] } | null;
    if (b?.issues?.length) {
      return b.issues
        .slice(0, 5)
        .map((i) => `${(i.path ?? []).join(".") || "input"}: ${i.message ?? "invalid"}`)
        .join(" · ");
    }
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** <input type="datetime-local"> value -> ISO (browser local time). */
export function localInputToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const inputClass =
  "block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:bg-gray-50";

export const labelClass = "block text-sm font-medium text-gray-700";
export const hintClass = "mt-1 text-xs text-gray-500";
