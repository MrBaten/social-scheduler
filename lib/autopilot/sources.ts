import type { ApSourceParams, ApSourceType, FeedItem } from "./types";
import { parseFeed, parseGdelt } from "./feeds";
import { fetchText } from "./fetcher";

// Source adapters. Each kind knows how to validate its config, build a request URL and parse
// the response. To add a paid source later (e.g. Feedly), add one entry here plus its type in
// lib/autopilot/types.ts; nothing else in the pipeline changes.

export interface SourceConfig {
  type: ApSourceType;
  url?: string | null;
  query?: string | null;
  params?: ApSourceParams;
}

export interface SourceAdapter {
  label: string;
  /** Returns an error message, or null when the config is usable. */
  validate(c: SourceConfig): string | null;
  requestUrl(c: SourceConfig): string;
  parse(body: string): FeedItem[];
  /** Minimum ms between requests to this provider across the whole process. */
  minGapMs?: number;
}

export function googleNewsUrl(query: string, p: ApSourceParams = {}): string {
  const hl = (p.hl || "en").trim();
  const gl = (p.gl || "BD").trim().toUpperCase();
  const lang = hl.split("-")[0];
  const ceid = (p.ceid || `${gl}:${lang}`).trim();
  const qs = new URLSearchParams({ q: query, hl, gl, ceid });
  return `https://news.google.com/rss/search?${qs.toString()}`;
}

export function gdeltUrl(query: string, p: ApSourceParams = {}): string {
  const max = Math.min(250, Math.max(1, Math.round(p.maxrecords ?? 50)));
  const timespan = /^\d+(min|h|hours|d|days|w|weeks|m|months)$/i.test(p.timespan ?? "") ? p.timespan! : "1d";
  const qs = new URLSearchParams({
    query,
    mode: "artlist",
    format: "json",
    sort: "DateDesc",
    maxrecords: String(max),
    timespan,
  });
  return `https://api.gdeltproject.org/api/v2/doc/doc?${qs.toString()}`;
}

export const SOURCE_ADAPTERS: Record<ApSourceType, SourceAdapter> = {
  rss: {
    label: "RSS / Atom feed",
    validate: (c) => (c.url && /^https?:\/\//i.test(c.url.trim()) ? null : "Enter the feed URL (http or https)"),
    requestUrl: (c) => c.url!.trim(),
    parse: (body) => parseFeed(body).items,
  },
  google_news: {
    label: "Google News search",
    validate: (c) => (c.query?.trim() ? null : "Enter a search query"),
    requestUrl: (c) => googleNewsUrl(c.query!.trim(), c.params),
    parse: (body) => parseFeed(body).items,
  },
  gdelt: {
    label: "GDELT search",
    // GDELT needs keywords of 3+ letters and rejects very short/odd queries with a text error.
    validate: (c) => (c.query && c.query.trim().length >= 3 ? null : "Enter a GDELT query (at least 3 characters)"),
    requestUrl: (c) => gdeltUrl(c.query!.trim(), c.params),
    parse: parseGdelt,
    // GDELT asks for roughly one request every 5 seconds from a client.
    minGapMs: 5_500,
  },
};

const lastRequestAt = new Map<ApSourceType, number>();

async function respectGap(type: ApSourceType, gap: number | undefined): Promise<void> {
  if (!gap) return;
  const wait = (lastRequestAt.get(type) ?? 0) + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt.set(type, Date.now());
}

export type SourceFetcher = (c: SourceConfig) => Promise<FeedItem[]>;

/** Fetch and parse one source. Throws on network/parse errors (caller records them). */
export const fetchSourceItems: SourceFetcher = async (c) => {
  const adapter = SOURCE_ADAPTERS[c.type];
  if (!adapter) throw new Error(`Unknown source type: ${c.type}`);
  const err = adapter.validate(c);
  if (err) throw new Error(err);
  await respectGap(c.type, adapter.minGapMs);
  const body = await fetchText(adapter.requestUrl(c), c.type === "gdelt" ? "application/json" : undefined);
  return adapter.parse(body);
};
