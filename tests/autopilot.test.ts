import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, newId, nowIso, resetDbForTests } from "../lib/db";
import { demoAccountsFor } from "../lib/platforms";
import { saveConnectedAccounts } from "../lib/accounts";
import { getPost, listPosts } from "../lib/posts";
import { processDuePosts } from "../lib/scheduler";
import { HttpError } from "../lib/api";
import type { SocialAccountPublic } from "../lib/types";
import { normalizeUrl, titleKey, containsTerm, tokenize } from "../lib/autopilot/text";
import { parseFeed, parseGdelt, parseGdeltDate } from "../lib/autopilot/feeds";
import { googleNewsUrl, gdeltUrl } from "../lib/autopilot/sources";
import { scoreItem, type NicheProfile } from "../lib/autopilot/relevance";
import { ingestSource, processNewItems, storeItems, MAX_SOURCE_ERRORS } from "../lib/autopilot/ingest";
import { localDayKey, nextFreeSlot, openSlot, slotsForDay, zonedToUtc, type SlotConfig } from "../lib/autopilot/slots";
import { assertPublicUrl, isPrivateIp, FetchError } from "../lib/autopilot/fetcher";
import { aiStatus, extractJsonObject, type AiClient } from "../lib/autopilot/ai";
import { ensureCredit, fillTemplate, generatePosts } from "../lib/autopilot/generate";
import {
  addSource,
  createAutopilot,
  deleteAutopilot,
  editDraft,
  getDraft,
  listAutopilots,
  listDrafts,
  listSources,
  rejectDraft,
  requireAutopilot,
  setGlobalPause,
  updateAutopilot,
  updateSource,
} from "../lib/autopilot/store";
import { approveDraft } from "../lib/autopilot/handoff";
import { pickTopic, runAutopilot, summarizeAutopilots } from "../lib/autopilot/pipeline";
import { autopilotTick } from "../lib/autopilot/worker";
import type { ApItemRow, ApSourceRow, ApTopicRow, AutopilotRow, FeedItem } from "../lib/autopilot/types";
import { ATOM_FIXTURE, GDELT_FIXTURE, GOOGLE_NEWS_FIXTURE, RSS_FIXTURE, item } from "./autopilot.fixtures";

process.env.DEMO_PUBLISH_DELAY_MS = "5";
delete process.env.AI_API_KEY;

function makeUser(name: string): string {
  const id = newId("u_");
  getDb()
    .prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, 'x', ?)")
    .run(id, `${id}@example.com`, name, nowIso());
  return id;
}

function accounts(userId: string, name: string) {
  const meta = saveConnectedAccounts(userId, "meta", demoAccountsFor("meta", name), true);
  const li = saveConnectedAccounts(userId, "linkedin", demoAccountsFor("linkedin", name), true);
  const yt = saveConnectedAccounts(userId, "google", demoAccountsFor("google", name), true);
  return {
    fb: meta.find((a) => a.platform === "facebook")!,
    ig: meta.find((a) => a.platform === "instagram")!,
    li: li[0],
    yt: yt[0],
  };
}

function insertImage(userId: string): string {
  const id = newId("m_");
  getDb()
    .prepare(
      `INSERT INTO media (id, user_id, filename, mime_type, size_bytes, path, public_url, created_at)
       VALUES (?, ?, ?, 'image/jpeg', 10, ?, ?, ?)`,
    )
    .run(id, userId, `${id}.jpg`, `/tmp/${id}.jpg`, `http://localhost:3000/uploads/${id}.jpg`, nowIso());
  return id;
}

const PROFILE: NicheProfile = {
  keywords: ["technology", "5G", "fintech", "AI", "প্রযুক্তি", "ফিনটেক"],
  region_terms: ["Bangladesh", "Dhaka", "বাংলাদেশ", "ঢাকা"],
  banned_terms: ["betting"],
  max_age_hours: 48,
  min_score: 30,
};

function apRow(userId: string, id: string): AutopilotRow {
  return requireAutopilot(userId, id);
}

function catchErr(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

// ---------------------------------------------------------------- pure helpers

describe("text + parsers", () => {
  it("normalises URLs for exact dedupe", () => {
    expect(normalizeUrl("https://www.Example.com/a/b/?utm_source=x&id=2&fbclid=1#top")).toBe("example.com/a/b?id=2");
    expect(normalizeUrl("http://example.com:80/a/")).toBe("example.com/a");
    expect(normalizeUrl("javascript:alert(1)")).toBe("");
    expect(normalizeUrl("not a url")).toBe("");
  });

  it("tokenises Bangla and English and matches terms correctly", () => {
    expect(tokenize("বাংলাদেশে নতুন ফিনটেক")).toContain("ফিনটেক");
    expect(containsTerm("He said the plan works", "ai")).toBe(false);
    expect(containsTerm("New AI policy", "ai")).toBe(true);
    expect(containsTerm("ঢাকায় নতুন অফিস", "ঢাকা")).toBe(true);
    expect(titleKey("Launches: 5G in Dhaka!")).toBe(titleKey("launched 5g IN dhaka"));
  });

  it("parses RSS with CDATA, entities, HTML descriptions and skips items without links", () => {
    const f = parseFeed(RSS_FIXTURE);
    expect(f.title).toBe("Dhaka Tech Daily");
    expect(f.items).toHaveLength(2);
    expect(f.items[0].title).toBe("Grameenphone launches 5G service in Dhaka & Chattogram");
    expect(f.items[0].url).toBe("https://dhakatech.example/news/gp-5g?utm_source=rss&utm_medium=feed");
    expect(f.items[0].summary).toBe("The operator said the 5G rollout starts with 20 sites.");
    expect(f.items[0].publisher).toBe("Dhaka Tech Daily");
    expect(f.items[0].published_at).toBe("2026-11-23T04:00:00.000Z");
    expect(f.items[1].published_at).toBe("2026-11-22T21:00:00.000Z");
  });

  it("parses Google News items: strips publisher suffix and ignores headline-only descriptions", () => {
    const [it0] = parseFeed(GOOGLE_NEWS_FIXTURE).items;
    expect(it0.title).toBe("GP rolls out 5G in Dhaka, Chattogram");
    expect(it0.publisher).toBe("The Daily Example");
    expect(it0.summary).toBe("");
  });

  it("parses Atom (alternate link, html title)", () => {
    const [e] = parseFeed(ATOM_FIXTURE).items;
    expect(e.url).toBe("https://blog.example/posts/bkash-savings");
    expect(e.title).toBe("Bkash adds new savings feature");
    expect(e.publisher).toBe("Startup Blog");
  });

  it("parses GDELT ArtList JSON and surfaces GDELT's text errors", () => {
    const items = parseGdelt(GDELT_FIXTURE);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ url: "https://outlet.example/bd-ai-policy", publisher: "outlet.example", published_at: "2026-11-23T06:15:00.000Z" });
    expect(parseGdeltDate("20260102T030405Z")).toBe("2026-01-02T03:04:05.000Z");
    expect(() => parseGdelt("Your search contained a keyword that was too short.")).toThrow(/GDELT: Your search/);
    expect(parseFeed("<html>garbage</html>").items).toEqual([]);
  });

  it("builds Google News and GDELT request URLs", () => {
    const g = new URL(googleNewsUrl("প্রযুক্তি বাংলাদেশ", { hl: "bn", gl: "bd" }));
    expect(g.origin + g.pathname).toBe("https://news.google.com/rss/search");
    expect(g.searchParams.get("q")).toBe("প্রযুক্তি বাংলাদেশ");
    expect(g.searchParams.get("ceid")).toBe("BD:bn");
    const d = new URL(gdeltUrl("technology sourcecountry:bangladesh", { timespan: "bogus", maxrecords: 999 }));
    expect(d.searchParams.get("mode")).toBe("artlist");
    expect(d.searchParams.get("format")).toBe("json");
    expect(d.searchParams.get("timespan")).toBe("1d");
    expect(d.searchParams.get("maxrecords")).toBe("250");
  });
});

describe("safe fetch guard", () => {
  it("blocks private, loopback, link-local and metadata addresses", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    const publicLookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as never;
    const privateLookup = (async () => [{ address: "10.0.0.5", family: 4 }]) as never;
    await expect(assertPublicUrl("https://news.example/feed", publicLookup)).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl("https://internal.example/feed", privateLookup)).rejects.toBeInstanceOf(FetchError);
    await expect(assertPublicUrl("http://localhost:3000/api", publicLookup)).rejects.toThrow(/not allowed/);
    await expect(assertPublicUrl("http://app.railway.internal/", publicLookup)).rejects.toThrow(/not allowed/);
    await expect(assertPublicUrl("file:///etc/passwd", publicLookup)).rejects.toThrow(/http/);
    await expect(assertPublicUrl("http://user:pw@news.example/", publicLookup)).rejects.toThrow(/credentials/);
  });
});

describe("relevance scoring", () => {
  const now = new Date("2026-11-23T08:00:00Z");
  const base = { fetched_at: now.toISOString(), published_at: new Date(now.getTime() - 2 * 3_600_000).toISOString() };

  it("scores title keyword matches above summary matches, adds region and freshness", () => {
    const inTitle = scoreItem({ ...base, title: "5G launches in Dhaka", summary: "" }, PROFILE, now);
    const inSummary = scoreItem({ ...base, title: "Operator news", summary: "The 5G rollout covers Dhaka" }, PROFILE, now);
    expect(inTitle.score).toBe(20 + 20 + 20); // keyword in title + region + fresh (<6h)
    expect(inSummary.score).toBe(10 + 20 + 20);
    expect(inTitle.archive).toBeNull();
    expect(inTitle.matched).toEqual(expect.arrayContaining(["5G", "Dhaka"]));
  });

  it("archives banned topics, stale items and off-niche items instead of deleting them", () => {
    expect(scoreItem({ ...base, title: "Online betting app launches in Dhaka", summary: "" }, PROFILE, now).archive).toBe("banned");
    const old = { fetched_at: now.toISOString(), published_at: new Date(now.getTime() - 60 * 3_600_000).toISOString() };
    expect(scoreItem({ ...old, title: "5G in Dhaka", summary: "" }, PROFILE, now).archive).toBe("too_old");
    expect(scoreItem({ ...base, title: "Cricket team wins in Dhaka", summary: "" }, PROFILE, now).archive).toBe("low_score");
  });

  it("matches Bangla keywords with suffixes", () => {
    const r = scoreItem({ ...base, title: "ঢাকায় নতুন ফিনটেক সেবা", summary: "" }, PROFILE, now);
    expect(r.archive).toBeNull();
    expect(r.matched).toEqual(expect.arrayContaining(["ফিনটেক", "ঢাকা"]));
  });
});

describe("slots (Asia/Dhaka)", () => {
  const cfg: SlotConfig = { timezone: "Asia/Dhaka", window_start: "08:00", window_end: "23:00", frequency_minutes: 120, min_gap_minutes: 60, daily_cap: 12 };

  it("lays out the day's slots in local time, capped", () => {
    const day = new Date("2026-11-23T06:00:00Z"); // 12:00 in Dhaka
    const slots = slotsForDay(day, cfg);
    expect(slots[0].toISOString()).toBe("2026-11-23T02:00:00.000Z"); // 08:00 +06
    expect(slots.at(-1)!.toISOString()).toBe("2026-11-23T16:00:00.000Z"); // 22:00 +06 (next would be 24:00)
    expect(slots).toHaveLength(8);
    expect(slotsForDay(day, { ...cfg, daily_cap: 3 })).toHaveLength(3);
    expect(zonedToUtc({ y: 2026, m: 11, d: 24, hh: 0, mm: 0 }, "Asia/Dhaka").toISOString()).toBe("2026-11-23T18:00:00.000Z");
    expect(localDayKey(new Date("2026-11-23T18:30:00Z"), "Asia/Dhaka")).toBe("2026-11-24");
  });

  it("opens a slot 20 minutes ahead, once", () => {
    const slot = new Date("2026-11-23T04:00:00Z"); // 10:00 Dhaka
    expect(openSlot(new Date(slot.getTime() - 30 * 60_000), cfg, new Set())).toBeNull();
    expect(openSlot(new Date(slot.getTime() - 10 * 60_000), cfg, new Set())?.toISOString()).toBe(slot.toISOString());
    expect(openSlot(new Date(slot.getTime() - 10 * 60_000), cfg, new Set([slot.toISOString()]))).toBeNull();
  });

  it("finds the next free slot honouring min gap and daily cap", () => {
    const now = new Date("2026-11-23T03:30:00Z"); // 09:30 Dhaka
    expect(nextFreeSlot(now, cfg, [])!.toISOString()).toBe("2026-11-23T04:00:00.000Z");
    expect(nextFreeSlot(now, cfg, [new Date("2026-11-23T04:30:00Z")])!.toISOString()).toBe("2026-11-23T06:00:00.000Z");
    const full = slotsForDay(now, cfg);
    expect(nextFreeSlot(now, { ...cfg, daily_cap: full.length }, full)!.toISOString()).toBe("2026-11-24T02:00:00.000Z");
  });
});

describe("generation helpers", () => {
  const story = { headline: "Dhaka gets 5G", summary: "Rollout starts with 20 sites.", source_name: "Dhaka Tech Daily", source_url: "https://dhakatech.example/x", published_at: null, related_headlines: [] };

  it("fills templates and always credits the source with its link", () => {
    expect(fillTemplate("{headline} | {source} | {link} | {unknown}", story)).toBe("Dhaka gets 5G | Dhaka Tech Daily | https://dhakatech.example/x | {unknown}");
    expect(ensureCredit("Just text", story, "en")).toBe("Just text\n\nSource: Dhaka Tech Daily https://dhakatech.example/x");
    expect(ensureCredit("Just text", story, "bn")).toContain("সূত্র: Dhaka Tech Daily");
    expect(ensureCredit("Dhaka Tech Daily https://dhakatech.example/x", story, "en")).toBe("Dhaka Tech Daily https://dhakatech.example/x");
  });

  it("uses the AI answer per platform and flags numbers that aren't in the source", async () => {
    const ai: AiClient = async () =>
      '```json\n{"facebook":"Dhaka gets 5G at 20 sites, 99% coverage. Source: Dhaka Tech Daily https://dhakatech.example/x","linkedin":"5G arrives."}\n```';
    const r = await generatePosts(
      { story, platforms: ["facebook", "linkedin"], templates: {}, language: "en", niche_description: "BD tech", banned_terms: [] },
      ai,
      "ai:test/model",
    );
    expect(r.generator).toBe("ai:test/model");
    expect(r.ai_calls).toBe(1);
    expect(r.texts.linkedin).toContain("https://dhakatech.example/x"); // credit appended
    expect(r.flags.map((f) => f.code)).toContain("unverified_numbers"); // "99" not in the source
    expect(r.flags.find((f) => f.code === "unverified_numbers")!.message).toContain("99");
  });

  it("extracts JSON from chatty answers and reports AI config problems", () => {
    expect(extractJsonObject('Sure! {"facebook":"x"} hope it helps')).toEqual({ facebook: "x" });
    expect(extractJsonObject("no json")).toBeNull();
    const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
    expect(aiStatus(env({})).problem).toBe("AI_API_KEY is not set");
    expect(aiStatus(env({ AI_API_KEY: "k", AI_PROVIDER: "openai" })).problem).toMatch(/AI_MODEL/);
    expect(aiStatus(env({ AI_API_KEY: "k", AI_PROVIDER: "anthropic" })).configured).toBe(true);
    expect(aiStatus(env({ AI_API_KEY: "k", AI_PROVIDER: "openai_compatible", AI_MODEL: "m" })).problem).toMatch(/AI_BASE_URL/);
  });
});

// ---------------------------------------------------------------- DB-backed

describe("AutoPilot with the database", () => {
  const NOW = new Date("2026-11-23T04:00:00Z"); // 10:00 Dhaka, a slot time with defaults
  let alice: string;
  let bob: string;
  let a: ReturnType<typeof accounts>;
  let b: ReturnType<typeof accounts>;

  beforeEach(() => {
    // createPost() checks "not in the past" against the real clock: pin Date (not timers) to NOW.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    resetDbForTests();
    alice = makeUser("Alice");
    bob = makeUser("Bob");
    a = accounts(alice, "Alice");
    b = accounts(bob, "Bob");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeAutopilot(userId: string, accts: SocialAccountPublic[], over: Record<string, unknown> = {}) {
    return createAutopilot(userId, {
      name: "BD tech news",
      niche_description: "Bangladesh technology news",
      keywords: PROFILE.keywords,
      region_terms: PROFILE.region_terms,
      banned_terms: PROFILE.banned_terms,
      language: "en",
      account_ids: accts.map((x) => x.id),
      sources: [{ type: "rss", url: "https://dhakatech.example/feed" }],
      templates: [{ name: "Brief", platform: "all", structure: "{headline}\n\n{summary}\n\nSource: {source}\n{link}" }],
      ...over,
    });
  }

  const STORY: FeedItem[] = [
    item({ title: "Grameenphone launches 5G service in Dhaka", url: "https://a.example/gp-5g", summary: "Grameenphone launched 5G service in Dhaka with 20 sites.", publisher: "Outlet A" }, NOW),
    item({ title: "GP rolls out 5G service in Dhaka", url: "https://b.example/news/1?utm_source=x", summary: "Grameenphone 5G service rollout in Dhaka begins.", publisher: "Outlet B" }, NOW),
    item({ title: "Grameenphone 5G service now live in Dhaka", url: "https://c.example/live", summary: "5G service by Grameenphone is live in Dhaka.", publisher: "Outlet C" }, NOW),
    item({ title: "New fintech startup raises funds in Bangladesh", url: "https://a.example/fintech", summary: "A Dhaka fintech startup raised seed funding.", publisher: "Outlet A" }, NOW),
  ];

  describe("dedupe", () => {
    it("drops exact URL repeats (after normalisation) and same-title syndication", () => {
      const ap = makeAutopilot(alice, [a.fb]);
      const r1 = storeItems(ap.id, null, STORY, NOW);
      expect(r1.inserted).toBe(4);
      const r2 = storeItems(
        ap.id,
        null,
        [
          item({ title: "Different title", url: "https://www.b.example/news/1/?utm_medium=rss#x" }, NOW), // same URL as STORY[1]
          item({ title: "Grameenphone launches 5G service in Dhaka!", url: "https://mirror.example/copy" }, NOW), // same title as STORY[0]
          item({ title: "Brand new story about AI in Dhaka", url: "https://d.example/ai" }, NOW),
        ],
        NOW,
      );
      expect(r2).toEqual({ fetched: 3, inserted: 1, duplicates: 2 });
    });

    it("groups several outlets on one story into one topic, keeps other stories apart", () => {
      const ap = makeAutopilot(alice, [a.fb]);
      storeItems(ap.id, null, STORY, NOW);
      const res = processNewItems(apRow(alice, ap.id), NOW);
      expect(res).toMatchObject({ scored: 4, archived: 0, new_topics: 2, joined: 2 });
      const topics = getDb().prepare("SELECT * FROM ap_topics WHERE autopilot_id = ? ORDER BY item_count DESC").all(ap.id) as ApTopicRow[];
      expect(topics.map((t) => t.item_count)).toEqual([3, 1]);
      expect(topics[0].best_score).toBeGreaterThan(topics[1].best_score - 1); // coverage bonus
    });

    it("clusters Bangla coverage of the same story", () => {
      const ap = makeAutopilot(alice, [a.fb]);
      storeItems(
        ap.id,
        null,
        [
          item({ title: "ঢাকায় গ্রামীণফোনের ফাইভজি সেবা চালু", url: "https://bn1.example/1", summary: "গ্রামীণফোন ঢাকায় ফাইভজি সেবা চালু করেছে প্রযুক্তি" }, NOW),
          item({ title: "গ্রামীণফোনের ফাইভজি সেবা চালু হলো ঢাকায়", url: "https://bn2.example/2", summary: "ঢাকায় গ্রামীণফোন ফাইভজি সেবা প্রযুক্তি" }, NOW),
        ],
        NOW,
      );
      const res = processNewItems(apRow(alice, ap.id), NOW);
      expect(res.new_topics).toBe(1);
      expect(res.joined).toBe(1);
    });

    it("never picks a story again within 72 hours", async () => {
      const ap = makeAutopilot(alice, [a.fb]);
      const fetcher = async () => STORY;
      const r1 = await runAutopilot(ap.id, { trigger: "manual", forceFetch: true, forceGenerate: true, fetcher, ai: null, now: NOW });
      const r2 = await runAutopilot(ap.id, { trigger: "manual", forceFetch: true, forceGenerate: true, fetcher, ai: null, now: new Date(NOW.getTime() + 60_000) });
      const later = new Date(NOW.getTime() + 2 * 60_000);
      // Follow-up coverage of the first story arrives: it joins the used topic, no new draft.
      const r3 = await runAutopilot(ap.id, {
        trigger: "manual",
        forceFetch: true,
        forceGenerate: true,
        ai: null,
        now: later,
        fetcher: async () => [item({ title: "Grameenphone 5G service in Dhaka draws crowds", url: "https://e.example/5g", summary: "Grameenphone 5G service Dhaka" }, later)],
      });
      const drafts = listDrafts(alice, ap.id);
      expect([r1.draft_id, r2.draft_id].every(Boolean)).toBe(true);
      expect(r3.draft_id).toBeNull();
      expect(drafts).toHaveLength(2);
      expect(new Set(drafts.map((d) => d.topic_id)).size).toBe(2);
    });
  });

  describe("pipeline", () => {
    it("ingests, scores, picks the biggest story and writes a credited draft to the inbox — without creating any post", async () => {
      const ap = makeAutopilot(alice, [a.fb, a.ig, a.li]);
      const r = await runAutopilot(ap.id, { trigger: "manual", forceFetch: true, forceGenerate: true, fetcher: async () => STORY, ai: null, now: NOW });
      expect(r.error).toBeNull();
      expect(r.counts).toMatchObject({ sources_fetched: 1, items_found: 4, new_topics: 2, drafts: 1 });
      const [d] = listDrafts(alice, ap.id, "in_review");
      expect(d.headline).toMatch(/5G/); // 3-outlet story wins
      expect(Object.keys(d.texts).sort()).toEqual(["facebook", "instagram", "linkedin"]);
      for (const t of Object.values(d.texts)) expect(t).toContain(d.source_url);
      expect(d.qc_flags.map((f) => f.code)).toContain("no_ai");
      expect(d.related.length).toBe(2);
      expect(listPosts(alice)).toHaveLength(0); // nothing goes to the queue without approval
    });

    it("worker generates only for an open slot and respects pauses", async () => {
      const ap = makeAutopilot(alice, [a.fb]);
      const fetcher = async () => STORY;
      // 09:30 Dhaka: 10:00 slot is 30 min away -> fetch, no draft
      let r = await runAutopilot(ap.id, { trigger: "worker", fetcher, ai: null, now: new Date(NOW.getTime() - 30 * 60_000) });
      expect(r.draft_id).toBeNull();
      // 09:45: inside the 20-min lead -> draft for the 10:00 slot
      r = await runAutopilot(ap.id, { trigger: "worker", fetcher, ai: null, now: new Date(NOW.getTime() - 15 * 60_000) });
      expect(r.draft_id).not.toBeNull();
      expect(getDraft(alice, r.draft_id!)!.slot_at).toBe(NOW.toISOString());
      // same slot again -> nothing
      r = await runAutopilot(ap.id, { trigger: "worker", fetcher, ai: null, now: new Date(NOW.getTime() - 10 * 60_000) });
      expect(r.draft_id).toBeNull();
      // global pause stops the worker entirely
      setGlobalPause(alice, true);
      r = await runAutopilot(ap.id, { trigger: "worker", fetcher, ai: null, now: new Date(NOW.getTime() + 2 * 3_600_000 - 10 * 60_000) });
      expect(r.skipped_reason).toBe("paused");
      setGlobalPause(alice, false);
      updateAutopilot(alice, ap.id, { status: "paused" });
      const tick = await autopilotTick(new Date(NOW.getTime() + 2 * 3_600_000 - 10 * 60_000));
      expect(tick.autopilots).toBe(0);
    });

    it("pauses when the AI daily cap is reached", async () => {
      const ap = makeAutopilot(alice, [a.fb], { ai_daily_cap: 1 });
      const ai: AiClient = async () => JSON.stringify({ facebook: "Post text" });
      const r1 = await runAutopilot(ap.id, { trigger: "manual", forceFetch: true, forceGenerate: true, fetcher: async () => STORY, ai, now: NOW });
      expect(r1.draft_id).not.toBeNull();
      const r2 = await runAutopilot(ap.id, { trigger: "manual", forceFetch: true, forceGenerate: true, fetcher: async () => STORY, ai, now: new Date(NOW.getTime() + 60_000) });
      expect(r2.draft_id).toBeNull();
      const row = apRow(alice, ap.id);
      expect(row.status).toBe("paused");
      expect(row.paused_reason).toMatch(/AI daily cap/);
      // resuming clears the reason
      expect(updateAutopilot(alice, ap.id, { status: "active" }).paused_reason).toBeNull();
    });

    it("a failing source never stops the others and is paused after 5 failures in a row", async () => {
      const ap = makeAutopilot(alice, [a.fb]);
      addSource(alice, ap.id, { type: "google_news", query: "Bangladesh technology", params: { hl: "en", gl: "BD" } });
      const fetcher = async (c: { type: string }) => {
        if (c.type === "rss") throw new Error("HTTP 500");
        return STORY;
      };
      const r = await runAutopilot(ap.id, { trigger: "manual", forceFetch: true, forceGenerate: false, fetcher, ai: null, now: NOW });
      expect(r.counts).toMatchObject({ sources_fetched: 2, source_errors: 1, items_found: 4 });
      const rss = getDb().prepare("SELECT * FROM ap_sources WHERE autopilot_id = ? AND type = 'rss'").get(ap.id) as ApSourceRow;
      for (let i = 1; i < MAX_SOURCE_ERRORS; i++) {
        await ingestSource(getDb().prepare("SELECT * FROM ap_sources WHERE id = ?").get(rss.id) as ApSourceRow, fetcher, NOW);
      }
      const after = getDb().prepare("SELECT * FROM ap_sources WHERE id = ?").get(rss.id) as ApSourceRow;
      expect(after.enabled).toBe(0);
      expect(after.error_count).toBe(MAX_SOURCE_ERRORS);
      expect(after.last_error).toMatch(/Paused after 5 failures/);
      // re-enabling resets the count
      expect(updateSource(alice, ap.id, rss.id, { enabled: true })).toMatchObject({ enabled: true, error_count: 0, last_error: null });
    });

    it("pickTopic prefers bigger/fresher stories and skips archived ones", async () => {
      const ap = makeAutopilot(alice, [a.fb]);
      storeItems(ap.id, null, STORY, NOW);
      processNewItems(apRow(alice, ap.id), NOW);
      const pick = pickTopic(apRow(alice, ap.id), NOW)!;
      expect(pick.topic.item_count).toBe(3);
      const item0 = getDb().prepare("SELECT * FROM ap_items WHERE id = ?").get(pick.topic.best_item_id) as ApItemRow;
      expect(pick.item.id).toBe(item0.id);
    });
  });

  describe("approve -> queue hand-off", () => {
    async function draftFor(userId: string, apId: string) {
      const r = await runAutopilot(apId, { trigger: "manual", forceFetch: true, forceGenerate: true, fetcher: async () => STORY, ai: null, now: NOW });
      return r.draft_id!;
    }

    it("creates a normal queued post marked AutoPilot, skipping Instagram without an image", async () => {
      const ap = makeAutopilot(alice, [a.fb, a.ig, a.li]);
      const draftId = await draftFor(alice, ap.id);
      editDraft(alice, draftId, { texts: { facebook: "Edited FB text https://a.example/gp-5g" } });
      const now = new Date(NOW.getTime() + 5 * 60_000); // 10:05 Dhaka -> next free slot 12:00
      const res = approveDraft(alice, draftId, { when: "slot" }, now);

      expect(res.skipped).toEqual([expect.objectContaining({ platform: "instagram" })]);
      expect(res.post.origin).toBe("autopilot");
      expect(res.post.status).toBe("scheduled");
      expect(res.post.scheduled_at).toBe("2026-11-23T06:00:00.000Z");
      expect(res.post.targets.map((t) => t.platform).sort()).toEqual(["facebook", "linkedin"]);
      expect(res.post.targets.find((t) => t.platform === "facebook")!.text_override).toBe("Edited FB text https://a.example/gp-5g");
      expect(res.draft.status).toBe("scheduled");
      expect(res.draft.post_id).toBe(res.post.id);

      const row = getDb().prepare("SELECT origin, ap_draft_id FROM posts WHERE id = ?").get(res.post.id) as { origin: string; ap_draft_id: string };
      expect(row).toEqual({ origin: "autopilot", ap_draft_id: draftId });
      expect(listPosts(alice).map((p) => p.origin)).toEqual(["autopilot"]); // the Queue API sees the badge field

      // approving twice is refused and creates no second post
      expect(catchErr(() => approveDraft(alice, draftId, { when: "now" }, now))).toMatchObject({ status: 409 });
      expect(listPosts(alice)).toHaveLength(1);
    });

    it("includes Instagram when an image is attached, and the existing scheduler publishes it", async () => {
      const ap = makeAutopilot(alice, [a.fb, a.ig]);
      const draftId = await draftFor(alice, ap.id);
      editDraft(alice, draftId, { image_media_id: insertImage(alice) });
      const now = new Date();
      const res = approveDraft(alice, draftId, { when: "now" }, now);
      expect(res.skipped).toEqual([]);
      expect(res.post.media).toHaveLength(1);
      expect(res.post.targets.map((t) => t.platform).sort()).toEqual(["facebook", "instagram"]);

      // The publisher is unchanged: it simply sees a due post (demo accounts publish in-process).
      const pub = await processDuePosts(new Date(now.getTime() + 1000));
      expect(pub.published).toBe(2);
      expect(getPost(alice, res.post.id)!.status).toBe("published");
      const s = summarizeAutopilots(alice, now).find((x) => x.id === ap.id)!;
      expect(s.today.published).toBe(2);
    });

    it("keeps the minimum gap between AutoPilot posts and supports queue drafts", async () => {
      const ap = makeAutopilot(alice, [a.fb], { frequency_minutes: 60, min_gap_minutes: 90 });
      const r1 = await runAutopilot(ap.id, { trigger: "manual", forceFetch: true, forceGenerate: true, fetcher: async () => STORY, ai: null, now: NOW });
      const r2 = await runAutopilot(ap.id, { trigger: "manual", forceFetch: true, forceGenerate: true, fetcher: async () => STORY, ai: null, now: NOW });
      const now = new Date(NOW.getTime() + 5 * 60_000);
      const p1 = approveDraft(alice, r1.draft_id!, {}, now).post;
      const p2 = approveDraft(alice, r2.draft_id!, {}, now).post;
      const gapMin = (Date.parse(p2.scheduled_at!) - Date.parse(p1.scheduled_at!)) / 60_000;
      expect(gapMin).toBeGreaterThanOrEqual(90);

      const r3 = await runAutopilot(ap.id, {
        trigger: "manual",
        forceFetch: true,
        forceGenerate: true,
        ai: null,
        now: NOW,
        fetcher: async () => [item({ title: "Bangladesh AI policy draft published", url: "https://z.example/ai", summary: "Dhaka technology AI policy" }, NOW)],
      });
      const qd = approveDraft(alice, r3.draft_id!, { when: "queue_draft" }, now);
      expect(qd.post.status).toBe("draft");
      expect(qd.draft.status).toBe("approved");
    });

    it("rejects with a reason and refuses Instagram-only approval without an image", async () => {
      const ap = makeAutopilot(alice, [a.ig]);
      const draftId = await draftFor(alice, ap.id);
      const err = catchErr(() => approveDraft(alice, draftId, {}, NOW)) as HttpError;
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/Instagram needs an image/);
      const d = rejectDraft(alice, draftId, "Not our audience");
      expect(d).toMatchObject({ status: "rejected", reject_reason: "Not our audience" });
      expect(catchErr(() => editDraft(alice, draftId, { texts: { instagram: "x" } }))).toMatchObject({ status: 409 });
    });

    it("runs Compose's platform validation (over-length text is a 400, nothing is queued)", async () => {
      const ap = makeAutopilot(alice, [a.li]);
      const draftId = await draftFor(alice, ap.id);
      editDraft(alice, draftId, { texts: { linkedin: "x".repeat(3000) } });
      getDb().prepare("UPDATE ap_drafts SET texts_json = ? WHERE id = ?").run(JSON.stringify({ linkedin: "x".repeat(3001) }), draftId);
      const err = catchErr(() => approveDraft(alice, draftId, { when: "now" }, NOW)) as HttpError;
      expect(err.status).toBe(400);
      expect(listPosts(alice)).toHaveLength(0);
      expect(getDraft(alice, draftId)!.status).toBe("in_review");
    });
  });

  describe("per-user isolation", () => {
    it("another user can't see, change, run-approve or reuse anything", async () => {
      const ap = makeAutopilot(alice, [a.fb]);
      const r = await runAutopilot(ap.id, { trigger: "manual", forceFetch: true, forceGenerate: true, fetcher: async () => STORY, ai: null, now: NOW });
      const draftId = r.draft_id!;
      const srcId = listSources(alice, ap.id)[0].id;

      expect(listAutopilots(bob)).toEqual([]);
      expect(summarizeAutopilots(bob)).toEqual([]);
      expect(getDraft(bob, draftId)).toBeNull();
      for (const fn of [
        () => requireAutopilot(bob, ap.id),
        () => listSources(bob, ap.id),
        () => listDrafts(bob, ap.id),
        () => updateAutopilot(bob, ap.id, { name: "hijack" }),
        () => updateSource(bob, ap.id, srcId, { enabled: false }),
        () => addSource(bob, ap.id, { type: "rss", url: "https://x.example/feed" }),
        () => editDraft(bob, draftId, { texts: { facebook: "hijack" } }),
        () => rejectDraft(bob, draftId, "x"),
        () => approveDraft(bob, draftId, { when: "now" }, NOW),
      ]) {
        expect(catchErr(fn)).toMatchObject({ status: 404 });
      }
      expect(deleteAutopilot(bob, ap.id)).toBe(false);

      // Bob can't target Alice's accounts or attach Alice's media
      expect(catchErr(() => makeAutopilot(bob, [a.fb]))).toMatchObject({ status: 400 });
      const bobAp = makeAutopilot(bob, [b.fb]);
      const rb = await runAutopilot(bobAp.id, { trigger: "manual", forceFetch: true, forceGenerate: true, fetcher: async () => STORY, ai: null, now: NOW });
      expect(catchErr(() => editDraft(bob, rb.draft_id!, { image_media_id: insertImage(alice) }))).toMatchObject({ status: 400 });

      // Alice's data unchanged; each sees only their own counts
      expect(apRow(alice, ap.id).name).toBe("BD tech news");
      expect(getDraft(alice, draftId)!.status).toBe("in_review");
      expect(summarizeAutopilots(alice).map((s) => s.today.inbox)).toEqual([1]);
      expect(summarizeAutopilots(bob).map((s) => s.today.inbox)).toEqual([1]);
    });

    it("PATCH changes only the fields sent (pause doesn't reset the profile, source toggle keeps its settings)", () => {
      const ap = makeAutopilot(alice, [a.fb, a.li], { frequency_minutes: 90, daily_cap: 5 });
      const paused = updateAutopilot(alice, ap.id, { status: "paused" });
      expect(paused).toMatchObject({ status: "paused", paused_reason: "Paused by you", frequency_minutes: 90, daily_cap: 5 });
      expect(paused.keywords).toEqual(PROFILE.keywords);
      expect(paused.account_ids).toEqual([a.fb.id, a.li.id]);
      const src = addSource(alice, ap.id, { type: "google_news", label: "GN", query: "Dhaka tech", interval_minutes: 30, params: { hl: "bn", gl: "BD" } });
      const off = updateSource(alice, ap.id, src.id, { enabled: false });
      expect(off).toMatchObject({ enabled: false, label: "GN", interval_minutes: 30, query: "Dhaka tech", params: { hl: "bn", gl: "BD" } });
    });

    it("rejects non-AutoPilot platforms and bad windows", () => {
      expect(catchErr(() => makeAutopilot(alice, [a.yt]))).toMatchObject({ status: 400 });
      expect(catchErr(() => makeAutopilot(alice, [a.fb], { window_start: "22:00", window_end: "08:00" }))).toMatchObject({ status: 400 });
    });

    it("deleting an autopilot keeps its already-queued posts", async () => {
      const ap = makeAutopilot(alice, [a.fb]);
      const r = await runAutopilot(ap.id, { trigger: "manual", forceFetch: true, forceGenerate: true, fetcher: async () => STORY, ai: null, now: NOW });
      const { post } = approveDraft(alice, r.draft_id!, { when: "now" }, NOW);
      expect(deleteAutopilot(alice, ap.id)).toBe(true);
      expect(getPost(alice, post.id)).not.toBeNull();
    });
  });

  it("migration is idempotent and adds the posts columns", () => {
    const cols = (getDb().prepare("PRAGMA table_info(posts)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["origin", "ap_draft_id"]));
    resetDbForTests(); // runs the migration on a fresh DB again without error
  });
});
