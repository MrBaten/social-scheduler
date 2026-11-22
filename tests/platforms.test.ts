import { beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db";
import { PublishError, type MediaItem, type PublishContent } from "@/lib/types";
import { PLATFORM_RULES, demoAccountsFor, publishTo, validateForPlatform } from "@/lib/platforms";
import { escapeLittleText } from "@/lib/platforms/linkedin";
import { NetworkError, errorFromResponse, noRetryIfUncertain } from "@/lib/platforms/http";
import { assertSameOrigin, HttpError } from "@/lib/api";
import { consumeOAuthState, createOAuthState } from "@/lib/platforms/oauth";
import {
  deleteAccount,
  ensureFreshToken,
  getAccountWithTokens,
  listAccounts,
  saveConnectedAccounts,
} from "@/lib/accounts";

process.env.DEMO_PUBLISH_DELAY_MS = "5";

const img = (n = 1, mime = "image/jpeg"): MediaItem => ({
  id: `m_img${n}`,
  mime_type: mime,
  kind: "image",
  path: `/tmp/img${n}.jpg`,
  public_url: `https://cdn.example.com/img${n}.jpg`,
  size_bytes: 1000,
  filename: `img${n}.jpg`,
});
const vid = (n = 1): MediaItem => ({
  id: `m_vid${n}`,
  mime_type: "video/mp4",
  kind: "video",
  path: `/tmp/vid${n}.mp4`,
  public_url: `https://cdn.example.com/vid${n}.mp4`,
  size_bytes: 100000,
  filename: `vid${n}.mp4`,
});
const content = (text: string, media: MediaItem[] = [], options: PublishContent["options"] = {}): PublishContent => ({
  text,
  media,
  options,
});

function addUser(id: string, name = "Test User") {
  getDb()
    .prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, 'x', ?)")
    .run(id, `${id}@example.com`, name, new Date().toISOString());
}

beforeEach(() => {
  resetDbForTests();
  addUser("u1", "Alice Smith");
  addUser("u2", "Bob");
});

describe("PLATFORM_RULES / validateForPlatform", () => {
  it("has rules for every platform", () => {
    expect(Object.keys(PLATFORM_RULES).sort()).toEqual(["facebook", "instagram", "linkedin", "tiktok", "youtube"]);
    expect(PLATFORM_RULES.youtube.requiredOptions).toContain("title");
  });

  it("facebook: text-only ok, too-long text rejected, mixing video+images rejected", () => {
    expect(validateForPlatform("facebook", content("hello"))).toEqual([]);
    expect(validateForPlatform("facebook", content("x".repeat(63207)))).not.toEqual([]);
    expect(validateForPlatform("facebook", content("hi", [img(), vid()]))).not.toEqual([]);
    expect(validateForPlatform("facebook", content("hi", [img(1), img(2), img(3)]))).toEqual([]);
    expect(validateForPlatform("facebook", content("hi", [img()], { link: "https://x.com" }))).not.toEqual([]);
  });

  it("instagram requires media, JPEG, and caps carousel size", () => {
    expect(validateForPlatform("instagram", content("caption"))).not.toEqual([]);
    expect(validateForPlatform("instagram", content("caption", [img()]))).toEqual([]);
    expect(validateForPlatform("instagram", content("caption", [img(1, "image/png")]))).not.toEqual([]);
    const eleven = Array.from({ length: 11 }, (_, i) => img(i));
    expect(validateForPlatform("instagram", content("c", eleven))).not.toEqual([]);
    // carousels may mix images and videos
    expect(validateForPlatform("instagram", content("c", [img(), vid()]))).toEqual([]);
    expect(validateForPlatform("instagram", content("c", [img()], { ig_type: "reel" }))).not.toEqual([]);
    expect(validateForPlatform("instagram", content("c", [img(1), img(2)], { ig_type: "story" }))).not.toEqual([]);
    expect(validateForPlatform("instagram", content("x".repeat(2201), [img()]))).not.toEqual([]);
  });

  it("linkedin: one video max, no image+video mix", () => {
    expect(validateForPlatform("linkedin", content("post"))).toEqual([]);
    expect(validateForPlatform("linkedin", content("post", [vid(1), vid(2)]))).not.toEqual([]);
    expect(validateForPlatform("linkedin", content("post", [img(), vid()]))).not.toEqual([]);
    expect(validateForPlatform("linkedin", content("x".repeat(3001)))).not.toEqual([]);
  });

  it("youtube: exactly one video and a title <= 100 chars", () => {
    expect(validateForPlatform("youtube", content("desc", [vid()], { title: "My video" }))).toEqual([]);
    expect(validateForPlatform("youtube", content("desc", [vid()]))).not.toEqual([]);
    expect(validateForPlatform("youtube", content("desc", [vid()], { title: "t".repeat(101) }))).not.toEqual([]);
    expect(validateForPlatform("youtube", content("desc", [img()], { title: "t" }))).not.toEqual([]);
    expect(validateForPlatform("youtube", content("desc", [], { title: "t" }))).not.toEqual([]);
  });

  it("tiktok: one video or 1-35 images, not both", () => {
    expect(validateForPlatform("tiktok", content("t", [vid()]))).toEqual([]);
    expect(validateForPlatform("tiktok", content("t", [img(1), img(2)]))).toEqual([]);
    expect(validateForPlatform("tiktok", content("t", [img(), vid()]))).not.toEqual([]);
    expect(validateForPlatform("tiktok", content("t"))).not.toEqual([]);
    const many = Array.from({ length: 36 }, (_, i) => img(i));
    expect(validateForPlatform("tiktok", content("t", many))).not.toEqual([]);
  });
});

describe("demo accounts", () => {
  it("meta yields one FB page + one IG account with demo_ ids", () => {
    const accts = demoAccountsFor("meta", "Alice Smith");
    expect(accts.map((a) => a.platform)).toEqual(["facebook", "instagram"]);
    for (const a of accts) {
      expect(a.platform_account_id.includes("demo_")).toBe(true);
      expect(a.access_token).toBe("demo-token");
    }
    expect(demoAccountsFor("google", "A")[0].platform).toBe("youtube");
    expect(demoAccountsFor("tiktok", "A")[0].platform).toBe("tiktok");
    expect(demoAccountsFor("linkedin", "A")[0].platform).toBe("linkedin");
  });

  it("saving demo accounts twice upserts (no duplicates)", () => {
    saveConnectedAccounts("u1", "meta", demoAccountsFor("meta", "Alice Smith"), true);
    saveConnectedAccounts("u1", "meta", demoAccountsFor("meta", "Alice Smith"), true);
    const list = listAccounts("u1");
    expect(list).toHaveLength(2);
    expect(list.every((a) => a.is_demo)).toBe(true);
  });
});

describe("publishTo (demo)", () => {
  function demoAccount(provider: "meta" | "google" = "meta", idx = 0) {
    const saved = saveConnectedAccounts("u1", provider, demoAccountsFor(provider, "Alice"), true);
    const acct = getAccountWithTokens("u1", saved[idx].id);
    expect(acct).not.toBeNull();
    return acct!;
  }

  it("succeeds with a fake id and example.com URL", async () => {
    const acct = demoAccount();
    const r = await publishTo(acct, content("Hello world"));
    expect(r.platform_post_id).toMatch(/^demo_facebook_/);
    expect(r.platform_post_url).toBe(`https://example.com/demo/facebook/${r.platform_post_id}`);
  });

  it("#fail throws a retryable PublishError", async () => {
    const acct = demoAccount();
    const err = await publishTo(acct, content("please #fail")).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err.retryable).toBe(true);
  });

  it("#fatal throws a non-retryable PublishError", async () => {
    const acct = demoAccount();
    const err = await publishTo(acct, content("boom #fatal")).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err.retryable).toBe(false);
  });

  it("still validates: instagram without media fails non-retryably", async () => {
    const ig = demoAccount("meta", 1);
    expect(ig.platform).toBe("instagram");
    const err = await publishTo(ig, content("no media")).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err.retryable).toBe(false);
    const ok = await publishTo(ig, content("with media", [img()]));
    expect(ok.platform_post_url).toContain("/demo/instagram/");
  });

  it("ensureFreshToken returns demo accounts unchanged", async () => {
    const acct = demoAccount("google");
    const fresh = await ensureFreshToken("u1", acct.id);
    expect(fresh.access_token).toBe("demo-token");
  });
});

describe("saveConnectedAccounts / listAccounts", () => {
  const real = (overrides: Partial<ReturnType<typeof demoAccountsFor>[number]> = {}) => ({
    platform: "linkedin" as const,
    platform_account_id: "urn:li:person:abc",
    display_name: "Alice",
    avatar_url: null,
    access_token: "secret-access-1",
    refresh_token: "secret-refresh-1",
    token_expires_at: new Date(Date.now() + 86400_000).toISOString(),
    scopes: "openid profile email w_member_social",
    meta: { kind: "person" },
    ...overrides,
  });

  it("upserts on (user, platform, account id) and keeps refresh token when absent", () => {
    const [first] = saveConnectedAccounts("u1", "linkedin", [real()], false);
    const [second] = saveConnectedAccounts(
      "u1",
      "linkedin",
      [real({ display_name: "Alice B", access_token: "secret-access-2", refresh_token: null })],
      false,
    );
    expect(second.id).toBe(first.id);
    expect(second.display_name).toBe("Alice B");
    expect(listAccounts("u1")).toHaveLength(1);

    const withTokens = getAccountWithTokens("u1", first.id)!;
    expect(withTokens.access_token).toBe("secret-access-2");
    expect(withTokens.refresh_token).toBe("secret-refresh-1");
    expect(withTokens.meta).toEqual({ kind: "person" });
  });

  it("stores tokens encrypted and never returns them from listAccounts", () => {
    saveConnectedAccounts("u1", "linkedin", [real()], false);
    const raw = getDb().prepare("SELECT access_token_enc, refresh_token_enc FROM social_accounts").get() as {
      access_token_enc: string;
      refresh_token_enc: string;
    };
    expect(raw.access_token_enc).not.toContain("secret-access-1");
    expect(raw.refresh_token_enc).not.toContain("secret-refresh-1");

    const list = listAccounts("u1");
    const json = JSON.stringify(list);
    expect(json).not.toContain("secret-access-1");
    expect(json).not.toContain("secret-refresh-1");
    expect(json).not.toContain("_enc");
    for (const a of list) {
      expect(a).not.toHaveProperty("access_token");
      expect(a).not.toHaveProperty("access_token_enc");
      expect(a).not.toHaveProperty("refresh_token");
    }
  });

  it("isolates users and deleteAccount only deletes own accounts", () => {
    const [a] = saveConnectedAccounts("u1", "linkedin", [real()], false);
    saveConnectedAccounts("u2", "linkedin", [real()], false); // same platform id, other user
    expect(listAccounts("u1")).toHaveLength(1);
    expect(listAccounts("u2")).toHaveLength(1);
    expect(getAccountWithTokens("u2", a.id)).toBeNull();
    expect(deleteAccount("u2", a.id)).toBe(false);
    expect(deleteAccount("u1", a.id)).toBe(true);
    expect(listAccounts("u1")).toHaveLength(0);
  });

  it("ensureFreshToken marks expired tokens without a refresh path", async () => {
    const [a] = saveConnectedAccounts(
      "u1",
      "meta",
      [
        {
          platform: "facebook",
          platform_account_id: "123",
          display_name: "Page",
          avatar_url: null,
          access_token: "t",
          refresh_token: null,
          token_expires_at: new Date(Date.now() - 1000).toISOString(),
          scopes: null,
          meta: {},
        },
      ],
      false,
    );
    const err = await ensureFreshToken("u1", a.id).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err.tokenExpired).toBe(true);
    expect(err.retryable).toBe(false);
    expect(listAccounts("u1")[0].status).toBe("expired");
  });

  it("ensureFreshToken leaves non-expiring tokens alone", async () => {
    const [a] = saveConnectedAccounts("u1", "linkedin", [real({ token_expires_at: null })], false);
    const fresh = await ensureFreshToken("u1", a.id);
    expect(fresh.access_token).toBe("secret-access-1");
  });
});

describe("oauth state", () => {
  it("is single-use and bound to the user", () => {
    const { state, codeChallenge } = createOAuthState("u1", "google", true);
    expect(codeChallenge).toBeTruthy();
    expect(consumeOAuthState(state, "u2", "google").ok).toBe(false);
    const ok = consumeOAuthState(state, "u1", "google");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.codeVerifier).toBeTruthy();
    expect(consumeOAuthState(state, "u1", "google").ok).toBe(false);
  });

  it("rejects states older than 15 minutes", () => {
    const { state } = createOAuthState("u1", "linkedin", false);
    getDb()
      .prepare("UPDATE oauth_states SET created_at = ? WHERE state = ?")
      .run(new Date(Date.now() - 16 * 60_000).toISOString(), state);
    expect(consumeOAuthState(state, "u1", "linkedin").ok).toBe(false);
  });
});

describe("linkedin little-text escaping", () => {
  it("escapes reserved chars but keeps hashtags", () => {
    expect(escapeLittleText("Hi (there) #launch @bob")).toBe("Hi \\(there\\) #launch \\@bob");
  });
});

describe("duplicate-publish guard", () => {
  it("makes a lost response on the final publish call non-retryable", async () => {
    const lost = noRetryIfUncertain("Facebook", () => Promise.reject(new NetworkError("Facebook: network error (timed out after 30s)")));
    await expect(lost).rejects.toMatchObject({ retryable: false, tokenExpired: false });
    await expect(lost).rejects.toThrow(/may have been published/);
  });

  it("keeps HTTP error classification (e.g. 5xx stays retryable)", async () => {
    const e5xx = errorFromResponse("Facebook", 503, "");
    await expect(noRetryIfUncertain("Facebook", () => Promise.reject(e5xx))).rejects.toBe(e5xx);
    expect(e5xx.retryable).toBe(true);
  });
});

describe("assertSameOrigin (login CSRF)", () => {
  const req = (headers: Record<string, string>) => new Request("http://internal:8080/api/auth/login", { method: "POST", headers });

  it("allows same-origin browser requests and non-browser clients", () => {
    expect(() => assertSameOrigin(req({ "sec-fetch-site": "same-origin", origin: "http://localhost:3000" }))).not.toThrow();
    expect(() => assertSameOrigin(req({ origin: "https://app.example.com", "x-forwarded-host": "app.example.com" }))).not.toThrow();
    expect(() => assertSameOrigin(req({}))).not.toThrow();
  });

  it("rejects cross-site requests", () => {
    expect(() => assertSameOrigin(req({ "sec-fetch-site": "cross-site" }))).toThrow(HttpError);
    expect(() => assertSameOrigin(req({ origin: "https://evil.example", host: "app.example.com" }))).toThrow(HttpError);
  });
});
