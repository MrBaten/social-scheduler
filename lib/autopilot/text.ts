// Pure text helpers: URL normalisation, HTML/entity cleanup, tokenising (works for Bangla and
// English), similarity. No I/O, so everything here is unit-tested directly.

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igshid|cmpid|ocid)$/i;

/**
 * Canonical form used for exact-URL dedupe: lowercase scheme/host, no "www.", no fragment, no
 * tracking params, sorted query, no trailing slash. Returns "" for non-http(s) input.
 */
export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const qs = params.length ? "?" + new URLSearchParams(params).toString() : "";
  let path = u.pathname.replace(/\/+$/, "");
  if (path === "") path = "";
  const port = u.port && !((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) ? `:${u.port}` : "";
  return `${host}${port}${path}${qs}`;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? m;
  });
}

/** Strip tags (after decoding, since feeds often double-encode HTML) and collapse whitespace. */
export function htmlToText(s: string): string {
  let t = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  t = decodeEntities(t);
  t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ");
  t = t.replace(/<br\s*\/?>|<\/p>/gi, " ");
  t = t.replace(/<[^>]+>/g, " ");
  t = decodeEntities(t); // entities that were inside the encoded HTML
  return t.replace(/\s+/g, " ").trim();
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

/** True when a meaningful share of letters are Bengali script (U+0980–U+09FF). */
export function isMostlyBangla(s: string): boolean {
  const letters = s.match(/\p{L}/gu)?.length ?? 0;
  if (!letters) return false;
  const bn = s.match(/[ঀ-৿]/g)?.length ?? 0;
  return bn / letters > 0.3;
}

const STOPWORDS = new Set(
  (
    // English
    "a an and are as at be been but by for from has have he her his in into is it its new news of on or our " +
    "says said say that the their them they this to was were will with after over amid about up out more than " +
    "who what when where why how not no yes can could would should may might also just year years day today " +
    // Bangla (common function words)
    "এবং ও এ এই সেই যে না হয় হবে হয়েছে করে করা করেছে জন্য থেকে দিয়ে নিয়ে একটি এক তার তাদের আর বা কি কী " +
    "সঙ্গে সাথে মধ্যে পর পরে আগে বলে বলেন জানান হলো হল ছিল আছে নেই"
  ).split(/\s+/),
);

/** Light English stemming so "launches"/"launched"/"launch" match. Non-Latin tokens are untouched. */
function stem(tok: string): string {
  if (!/^[a-z]+$/.test(tok) || tok.length <= 4) return tok;
  for (const suf of ["ing", "ed", "es", "s"]) {
    if (tok.endsWith(suf) && tok.length - suf.length >= 3) return tok.slice(0, -suf.length);
  }
  return tok;
}

/** Words of a text: NFC, lowercase, split on anything that isn't a letter/mark/number. */
export function tokenize(s: string): string[] {
  return s
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(stem);
}

export function tokenSet(s: string): Set<string> {
  return new Set(tokenize(s));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** |A∩B| / min(|A|,|B|): high when the shorter text is mostly contained in the longer. */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.min(a.size, b.size);
}

/** Exact-title key: same headline from the same story syndicated under different URLs. */
export function titleKey(title: string): string {
  return tokenize(title).join(" ");
}

/**
 * Story similarity in [0,1] between two items/topics, given title tokens and title+summary tokens.
 * Phase 1 uses word overlap instead of embeddings (no extra API, works for Bangla); the threshold
 * below was tuned on the test fixtures. Requires at least 3 shared words to avoid matching two
 * different stories that share a couple of names.
 */
export function storySimilarity(
  a: { title: Set<string>; all: Set<string> },
  b: { title: Set<string>; all: Set<string> },
): number {
  let shared = 0;
  for (const t of a.all) if (b.all.has(t)) shared++;
  if (shared < 3) return 0;
  return Math.max(jaccard(a.title, b.title), 0.85 * overlap(a.title, b.title), 0.7 * jaccard(a.all, b.all));
}

export const SAME_STORY_THRESHOLD = 0.5;

/** Case-insensitive term match. Latin terms need word boundaries ("ai" must not match "said");
 * Bangla terms match as substrings so suffixes like "ঢাকায়" still match "ঢাকা". */
export function containsTerm(text: string, term: string): boolean {
  const t = term.normalize("NFC").toLowerCase().trim();
  if (!t) return false;
  const hay = text.normalize("NFC").toLowerCase();
  if (/^[\p{Script=Latin}\p{N}\s.\-+&']+$/u.test(t)) {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "u").test(hay);
  }
  return hay.includes(t);
}

/** Numbers (incl. Bangla digits) appearing in a text, normalised to ASCII digits. */
export function numbersIn(s: string): string[] {
  const ascii = s.replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - 0x09e6));
  return (ascii.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,/g, ""));
}

export function safeJsonArray(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function safeJsonObject<T extends object>(json: string | null | undefined): Partial<T> {
  try {
    const v = JSON.parse(json ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Partial<T>) : {};
  } catch {
    return {};
  }
}
