import { PLATFORM_RULES } from "../platforms/rules";
import type { AiClient } from "./ai";
import { extractJsonObject } from "./ai";
import type { ApLanguage, ApPlatform, DraftTexts, QcFlag } from "./types";
import { containsTerm, numbersIn } from "./text";

// Turns one story + templates into per-platform post texts. With an AI client the model rewrites
// the story in its own words following the template; without one (no AI_API_KEY) the template
// variables are filled directly and the draft is flagged "no_ai" so you know to edit it.

export interface StoryInput {
  headline: string;
  summary: string;
  source_name: string;
  source_url: string;
  published_at: string | null;
  /** Headlines from other outlets on the same story (helps the model, never quoted). */
  related_headlines: string[];
}

export interface TemplateInput {
  name: string;
  structure: string;
  tone_notes: string;
  hashtag_rules: string;
}

export interface GenerateInput {
  story: StoryInput;
  platforms: ApPlatform[];
  templates: Partial<Record<ApPlatform, TemplateInput>>;
  language: ApLanguage;
  niche_description: string;
  banned_terms: string[];
}

export interface GenerateResult {
  texts: DraftTexts;
  flags: QcFlag[];
  generator: string;
  ai_calls: number;
}

export const TEMPLATE_VARIABLES = ["headline", "summary", "source", "link", "date"] as const;

const LANG_NAME: Record<ApLanguage, string> = {
  bn: "Bangla (Bengali script)",
  en: "English",
  both: "Bangla first, then the same post in English below it",
};

/** Platform caps used in prompts and flags; a little under the hard limit to leave room. */
export function platformLimit(p: ApPlatform): number {
  return PLATFORM_RULES[p].maxTextLength;
}

const PROMPT_TARGET: Record<ApPlatform, number> = { facebook: 900, instagram: 1500, linkedin: 1300 };

export function fillTemplate(structure: string, s: StoryInput): string {
  const date = s.published_at ? s.published_at.slice(0, 10) : "";
  const vars: Record<string, string> = {
    headline: s.headline,
    summary: s.summary || s.headline,
    source: s.source_name || hostOf(s.source_url),
    link: s.source_url,
    date,
  };
  return structure.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m)).replace(/\n{3,}/g, "\n\n").trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function buildPrompt(input: GenerateInput): { system: string; user: string } {
  const { story, language } = input;
  const system = [
    `You write social media posts for a page about: ${input.niche_description || "news in its niche"}.`,
    `Write in ${LANG_NAME[language]}.`,
    "Rules:",
    "- Summarise the story in your own words. Never copy sentences from the source.",
    "- Use only facts in the source material below. Do not add numbers, names, dates or quotes that are not in it.",
    "- No clickbait; the hook must not overstate the story.",
    "- Every post must credit the source by name and include the source link exactly as given.",
    input.banned_terms.length ? `- Never mention: ${input.banned_terms.join(", ")}.` : "",
    "- Follow each platform's template structure, tone notes and hashtag rules.",
    'Reply with ONLY a JSON object whose keys are the platform names and values are the finished post texts, e.g. {"facebook":"..."}.',
  ]
    .filter(Boolean)
    .join("\n");

  const parts: string[] = [
    "SOURCE MATERIAL",
    `Headline: ${story.headline}`,
    `Summary: ${story.summary || "(no summary; work from the headline only and keep the post short)"}`,
    `Source name: ${story.source_name || hostOf(story.source_url)}`,
    `Source link: ${story.source_url}`,
    story.published_at ? `Published: ${story.published_at}` : "",
    story.related_headlines.length ? `Other outlets' headlines on the same story:\n- ${story.related_headlines.slice(0, 5).join("\n- ")}` : "",
    "",
    "PLATFORMS",
  ];
  for (const p of input.platforms) {
    const t = input.templates[p];
    parts.push(
      `## ${p} (aim for under ${PROMPT_TARGET[p]} characters; hard limit ${platformLimit(p)})`,
      `Template structure (variables {headline} {summary} {source} {link} {date} are placeholders for YOUR rewritten content):\n${t?.structure ?? "{headline}\n\n{summary}\n\nSource: {source} {link}"}`,
      t?.tone_notes ? `Tone: ${t.tone_notes}` : "",
      t?.hashtag_rules ? `Hashtags: ${t.hashtag_rules}` : "",
      p === "instagram" ? "Note: links are not clickable on Instagram; still write the source name and link at the end." : "",
      "",
    );
  }
  return { system, user: parts.filter((x) => x !== "").join("\n") };
}

/** Make sure credit + link are present; append them when the model/template left them out. */
export function ensureCredit(text: string, s: StoryInput, language: ApLanguage): string {
  const name = s.source_name || hostOf(s.source_url);
  const hasLink = text.includes(s.source_url);
  const hasName = !name || containsTerm(text, name);
  if (hasLink && hasName) return text;
  const label = language === "bn" ? "সূত্র" : "Source";
  const line = hasLink ? `${label}: ${name}` : `${label}: ${name ? name + " " : ""}${s.source_url}`.trim();
  return `${text.trimEnd()}\n\n${line}`;
}

/** Phase 1 checks: cheap, rule-based, shown as flags in the inbox (nothing is blocked yet). */
export function basicFlags(texts: DraftTexts, s: StoryInput, banned: string[]): QcFlag[] {
  const flags: QcFlag[] = [];
  const sourceNums = new Set([...numbersIn(s.headline), ...numbersIn(s.summary), ...numbersIn(s.published_at ?? ""), ...numbersIn(s.source_url)]);
  for (const [p, text] of Object.entries(texts) as [ApPlatform, string][]) {
    if (!text.trim()) {
      flags.push({ code: "empty_text", platform: p, message: `${p}: empty text` });
      continue;
    }
    if (text.length > platformLimit(p)) {
      flags.push({ code: "over_length", platform: p, message: `${p}: ${text.length} characters (limit ${platformLimit(p)})` });
    }
    if (!text.includes(s.source_url)) flags.push({ code: "missing_link", platform: p, message: `${p}: source link missing` });
    const b = banned.find((t) => containsTerm(text, t));
    if (b) flags.push({ code: "banned_term", platform: p, message: `${p}: contains banned term "${b}"` });
    const textNoLink = text.split(s.source_url).join(" ");
    const extra = [...new Set(numbersIn(textNoLink))].filter((n) => !sourceNums.has(n) && n.length > 1);
    if (extra.length) {
      flags.push({ code: "unverified_numbers", platform: p, message: `${p}: numbers not in the source: ${extra.slice(0, 5).join(", ")}` });
    }
  }
  return flags;
}

export async function generatePosts(input: GenerateInput, ai: AiClient | null, aiLabel = "ai"): Promise<GenerateResult> {
  let texts: DraftTexts = {};
  let generator = "template";
  let aiCalls = 0;
  const flags: QcFlag[] = [];

  if (ai) {
    const { system, user } = buildPrompt(input);
    aiCalls = 1;
    const answer = await ai({ system, user, maxTokens: 2500 });
    const obj = extractJsonObject(answer);
    if (!obj) throw new Error("AI answer was not the expected JSON");
    for (const p of input.platforms) {
      const v = obj[p];
      if (typeof v === "string" && v.trim()) texts[p] = v.trim();
    }
    if (Object.keys(texts).length === 0) throw new Error("AI answer had no post texts");
    generator = aiLabel;
  } else {
    for (const p of input.platforms) {
      const t = input.templates[p];
      texts[p] = fillTemplate(t?.structure ?? "{headline}\n\n{summary}\n\nSource: {source} {link}", input.story);
    }
    flags.push({ code: "no_ai", message: "Written without AI (AI_API_KEY not set): template filled with the feed's own text. Rewrite before approving." });
  }

  texts = Object.fromEntries(Object.entries(texts).map(([p, t]) => [p, ensureCredit(t!, input.story, input.language)])) as DraftTexts;
  flags.push(...basicFlags(texts, input.story, input.banned_terms));
  return { texts, flags, generator, ai_calls: aiCalls };
}
