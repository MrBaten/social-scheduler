import type { FeedItem } from "./types";
import { htmlToText, truncate } from "./text";

// Pure parsers for RSS 2.0 / RDF / Atom and GDELT DOC 2.0 ArtList JSON. No XML dependency: news
// feeds are flat enough that a tolerant tag scanner is more robust than a strict parser (many
// feeds in the wild are not well-formed XML).

const SUMMARY_MAX = 600;

function stripCdata(s: string): string {
  return s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
}

/** Inner content of the first <tag ...>...</tag> (namespace prefix allowed in `tag`). */
function tagContent(block: string, tag: string): string | null {
  const esc = tag.replace(/[:.]/g, (c) => "\\" + c);
  const m = block.match(new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc}\\s*>`, "i"));
  return m ? stripCdata(m[1]) : null;
}

function tagAttr(block: string, tag: string, attr: string, filter?: (tagSrc: string) => boolean): string | null {
  const esc = tag.replace(/[:.]/g, (c) => "\\" + c);
  const re = new RegExp(`<${esc}\\b([^>]*)\\/?>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    if (filter && !filter(m[1])) continue;
    const a = m[1].match(new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
    if (a) return a[2] ?? a[3] ?? null;
  }
  return null;
}

function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
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
  const isAtom = /<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const channelTitle = text(tagContent(xml.replace(/<(item|entry)[\s\S]*$/i, ""), "title"));
  const items: FeedItem[] = [];

  if (isAtom) {
    for (const b of blocks(xml, "entry")) {
      const link =
        tagAttr(b, "link", "href", (src) => !/\brel\s*=/.test(src) || /\brel\s*=\s*["']alternate["']/i.test(src)) ??
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
