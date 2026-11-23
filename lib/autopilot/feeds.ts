import type { FeedItem } from "./types";
import { htmlToText, truncate } from "./text";

// Pure parsers for RSS 2.0 / RDF / Atom and GDELT DOC 2.0 ArtList JSON. No XML dependency: news
// feeds are flat enough that a tolerant tag scanner is more robust than a strict parser (many
// feeds in the wild are not well-formed XML).

const SUMMARY_MAX = 600;
/** Never look at more than this many items per feed. */
export const MAX_FEED_ITEMS = 200;

// All scanning below uses indexOf on a lowercased copy: linear time whatever the input, so a
// hostile or broken feed (e.g. 100k unclosed <item> tags) can't stall the shared server process.

function stripCdata(s: string): string {
  const t = s.trim();
  return t.startsWith("<![CDATA[") && t.endsWith("]]>") ? t.slice(9, -3) : s;
}

/** Position of the next opening `<tag` (followed by whitespace, ">" or "/") at or after `from`. */
function findOpen(lower: string, tag: string, from: number): number {
  const needle = "<" + tag;
  let i = from;
  for (;;) {
    const p = lower.indexOf(needle, i);
    if (p < 0) return -1;
    const next = lower.charCodeAt(p + needle.length);
    // ">"=62 "/"=47 space/tab/newline/cr
    if (next === 62 || next === 47 || next === 32 || next === 9 || next === 10 || next === 13) return p;
    i = p + needle.length;
  }
}

/** Contents of each <tag ...>...</tag> at the top level of `xml`, at most `max`. */
function blocks(xml: string, tag: string, max = MAX_FEED_ITEMS): string[] {
  const lower = xml.toLowerCase();
  const close = `</${tag}`;
  const out: string[] = [];
  let i = 0;
  while (out.length < max) {
    const start = findOpen(lower, tag, i);
    if (start < 0) break;
    const gt = lower.indexOf(">", start);
    if (gt < 0) break;
    const end = lower.indexOf(close, gt + 1);
    if (end < 0) break; // unclosed: stop, the rest of the document is not a valid block
    out.push(xml.slice(gt + 1, end));
    i = end + close.length;
  }
  return out;
}

/** Inner content of the first <tag ...>...</tag> (namespace prefix allowed in `tag`). */
function tagContent(block: string, tag: string): string | null {
  const lower = block.toLowerCase();
  const t = tag.toLowerCase();
  const start = findOpen(lower, t, 0);
  if (start < 0) return null;
  const gt = lower.indexOf(">", start);
  if (gt < 0 || lower.charCodeAt(gt - 1) === 47 /* self-closing */) return null;
  const end = lower.indexOf(`</${t}`, gt + 1);
  if (end < 0) return null;
  return stripCdata(block.slice(gt + 1, end));
}

function attrValue(tagSrc: string, attr: string): string | null {
  const m = tagSrc.match(new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/** Attribute of the first <tag ...> whose attributes pass `filter`. */
function tagAttr(block: string, tag: string, attr: string, filter?: (tagSrc: string) => boolean): string | null {
  const lower = block.toLowerCase();
  let i = 0;
  for (let n = 0; n < 50; n++) {
    const start = findOpen(lower, tag.toLowerCase(), i);
    if (start < 0) return null;
    const gt = lower.indexOf(">", start);
    if (gt < 0) return null;
    // Attribute text is bounded by this tag, so the small regex in attrValue stays linear.
    const src = block.slice(start + tag.length + 1, gt);
    i = gt + 1;
    if (filter && !filter(src)) continue;
    const v = attrValue(src, attr);
    if (v !== null) return v;
  }
  return null;
}

/** True when the body looks like RSS, RDF or Atom (even with zero items). */
export function looksLikeFeed(xml: string): boolean {
  const head = xml.slice(0, 4096).toLowerCase();
  return head.includes("<rss") || head.includes("<rdf:rdf") || head.includes("<feed") || head.includes("<channel");
}

export function parseDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = Date.parse(s.trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function text(s: string | null): string {
  return s ? htmlToText(s) : "";
}

/**
 * Google News titles end with " - Publisher"; drop it when it equals the <source> name so the
 * headline is clean and titles from different outlets can be compared.
 */
export function stripPublisherSuffix(title: string, publisher: string): string {
  if (!publisher) return title;
  const suffix = ` - ${publisher}`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title;
}

/** Parse RSS 2.0, RSS 1.0/RDF or Atom. Unknown/garbage input -> []. */
export function parseFeed(xml: string): { title: string; items: FeedItem[] } {
  const lower = xml.toLowerCase();
  const isAtom = findOpen(lower, "feed", 0) >= 0 && findOpen(lower, "entry", 0) >= 0;
  const firstItem = Math.min(...[findOpen(lower, "item", 0), findOpen(lower, "entry", 0)].map((p) => (p < 0 ? xml.length : p)));
  const channelTitle = text(tagContent(xml.slice(0, firstItem), "title"));
  const items: FeedItem[] = [];

  if (isAtom) {
    for (const b of blocks(xml, "entry")) {
      const link =
        tagAttr(b, "link", "href", (src) => {
          const rel = attrValue(src, "rel");
          return rel === null || rel.toLowerCase() === "alternate";
        }) ??
        tagAttr(b, "link", "href") ??
        "";
      const title = text(tagContent(b, "title"));
      const summary = text(tagContent(b, "summary") ?? tagContent(b, "content"));
      const author = text(tagContent(tagContent(b, "author") ?? "", "name"));
      if (!link || !title) continue;
      items.push({
        url: link.trim(),
        title,
        summary: truncate(summary, SUMMARY_MAX),
        publisher: channelTitle || author,
        published_at: parseDate(tagContent(b, "published") ?? tagContent(b, "updated")),
      });
    }
    return { title: channelTitle, items };
  }

  for (const b of blocks(xml, "item")) {
    let link = text(tagContent(b, "link"));
    if (!link) {
      const guid = text(tagContent(b, "guid"));
      if (/^https?:\/\//i.test(guid)) link = guid;
    }
    if (!link) link = tagAttr(b, "link", "href") ?? "";
    const sourceName = text(tagContent(b, "source"));
    const publisher = sourceName || channelTitle;
    const rawTitle = text(tagContent(b, "title"));
    const title = sourceName ? stripPublisherSuffix(rawTitle, sourceName) : rawTitle;
    let summary = text(tagContent(b, "description") ?? tagContent(b, "content:encoded"));
    // Google News descriptions are just the linked headline + publisher; don't treat as a summary.
    if (summary && sourceName && summary.startsWith(title)) summary = "";
    if (!link || !title) continue;
    items.push({
      url: link.trim(),
      title,
      summary: truncate(summary, SUMMARY_MAX),
      publisher,
      published_at: parseDate(tagContent(b, "pubDate") ?? tagContent(b, "dc:date")),
    });
  }
  return { title: channelTitle, items };
}

/** GDELT seendate "YYYYMMDDTHHMMSSZ" -> ISO. */
export function parseGdeltDate(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return parseDate(s);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
}

/**
 * GDELT DOC 2.0 ArtList JSON: { articles: [{ url, url_mobile, title, seendate, socialimage,
 * domain, language, sourcecountry }] }. GDELT returns plain-text errors (e.g. for a bad query)
 * with HTTP 200, so non-JSON input throws with that text.
 */
export function parseGdelt(body: string): FeedItem[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`GDELT: ${truncate(body.replace(/\s+/g, " ").trim(), 200) || "empty response"}`);
  }
  const arts = (data as { articles?: unknown })?.articles;
  if (!Array.isArray(arts)) return [];
  arts.length = Math.min(arts.length, MAX_FEED_ITEMS);
  const out: FeedItem[] = [];
  for (const a of arts) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    const url = typeof r.url === "string" ? r.url : "";
    const title = typeof r.title === "string" ? htmlToText(r.title) : "";
    if (!url || !title) continue;
    out.push({
      url,
      title,
      summary: "", // GDELT's DOC API returns metadata only, no article text.
      publisher: typeof r.domain === "string" ? r.domain : "",
      published_at: parseGdeltDate(r.seendate),
    });
  }
  return out;
}
