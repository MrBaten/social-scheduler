import { containsTerm } from "./text";

// Relevance score 0–100 of one item against the autopilot's niche profile. Deterministic and
// explainable (the reasons are shown on the Activity screen). Banned topics and stale items are
// archived with a reason instead of scored.

export interface NicheProfile {
  keywords: string[];
  region_terms: string[];
  banned_terms: string[];
  max_age_hours: number;
  min_score: number;
}

export interface RelevanceResult {
  score: number;
  /** Set when the item must be archived (never drafted). */
  archive: null | "banned" | "too_old" | "low_score";
  matched: string[];
}

export function scoreItem(
  item: { title: string; summary: string; published_at: string | null; fetched_at: string },
  p: NicheProfile,
  now: Date = new Date(),
): RelevanceResult {
  const title = item.title;
  const body = `${item.title}\n${item.summary}`;

  const banned = p.banned_terms.find((t) => containsTerm(body, t));
  if (banned) return { score: 0, archive: "banned", matched: [banned] };

  const when = Date.parse(item.published_at ?? item.fetched_at);
  const ageH = Number.isNaN(when) ? 0 : Math.max(0, (now.getTime() - when) / 3_600_000);
  if (ageH > p.max_age_hours) return { score: 0, archive: "too_old", matched: [] };

  const matched: string[] = [];
  let kw = 0;
  if (p.keywords.length === 0) kw = 40;
  for (const k of p.keywords) {
    if (containsTerm(title, k)) {
      kw += 20;
      matched.push(k);
    } else if (containsTerm(body, k)) {
      kw += 10;
      matched.push(k);
    }
  }
  kw = Math.min(60, kw);

  let region = 0;
  if (p.region_terms.length === 0) region = 10;
  else {
    const r = p.region_terms.find((t) => containsTerm(body, t));
    if (r) {
      region = 20;
      matched.push(r);
    }
  }

  const fresh = ageH <= 6 ? 20 : ageH <= 24 ? 10 : 0;
  const score = Math.min(100, kw + region + fresh);
  // With keywords configured, an item matching none of them is off-niche whatever its age.
  const offNiche = p.keywords.length > 0 && kw === 0;
  return { score, archive: offNiche || score < p.min_score ? "low_score" : null, matched };
}

/** Topic score: best item score plus a coverage bonus (more outlets = bigger story), max 100. */
export function topicScore(bestItemScore: number, itemCount: number): number {
  return Math.min(100, bestItemScore + Math.min(15, 5 * Math.max(0, itemCount - 1)));
}

/** Freshness factor for picking: 1.0 when new, halves every 12 hours. */
export function freshness(ageHours: number): number {
  return Math.pow(0.5, Math.max(0, ageHours) / 12);
}
