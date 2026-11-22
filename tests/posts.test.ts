import { beforeEach, describe, expect, it } from "vitest";
import { getDb, newId, nowIso, resetDbForTests } from "../lib/db";
import { demoAccountsFor } from "../lib/platforms";
import { saveConnectedAccounts } from "../lib/accounts";
import {
  PostValidationError,
  createPost,
  deletePost,
  getPost,
  listPosts,
  publishNow,
  recomputePostStatus,
  retryFailed,
  updatePost,
} from "../lib/posts";
import { getMediaItems } from "../lib/media";
import { HttpError } from "../lib/api";
import type { SocialAccountPublic } from "../lib/types";

process.env.DEMO_PUBLISH_DELAY_MS = "20";

function makeUser(name: string): string {
  const id = newId("u_");
  getDb()
    .prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, 'x', ?)")
    .run(id, `${id}@example.com`, name, nowIso());
  return id;
}

function insertMedia(userId: string, mime: string): string {
  const id = newId("m_");
  getDb()
    .prepare(
      `INSERT INTO media (id, user_id, filename, mime_type, size_bytes, path, public_url, created_at)
       VALUES (?, ?, ?, ?, 10, ?, ?, ?)`,
    )
    .run(id, userId, `${id}.bin`, mime, `/tmp/${id}`, `http://localhost:3000/uploads/${id}`, nowIso());
  return id;
}

function accounts(userId: string, name: string) {
  const meta = saveConnectedAccounts(userId, "meta", demoAccountsFor("meta", name), true);
  const li = saveConnectedAccounts(userId, "linkedin", demoAccountsFor("linkedin", name), true);
  return {
    fb: meta.find((a) => a.platform === "facebook")!,
    ig: meta.find((a) => a.platform === "instagram")!,
    li: li[0],
  };
}

function catchErr(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

describe("posts data layer", () => {
  let alice: string;
  let bob: string;
  let a: { fb: SocialAccountPublic; ig: SocialAccountPublic; li: SocialAccountPublic };
  let b: { fb: SocialAccountPublic; ig: SocialAccountPublic; li: SocialAccountPublic };

  beforeEach(() => {
    resetDbForTests();
    alice = makeUser("Alice");
    bob = makeUser("Bob");
    a = accounts(alice, "Alice");
    b = accounts(bob, "Bob");
  });

  it("creates a scheduled post with ordered media and per-target overrides", () => {
    const m1 = insertMedia(alice, "image/jpeg");
    const m2 = insertMedia(alice, "image/jpeg");
    const when = new Date(Date.now() + 3600_000).toISOString();
    const post = createPost(alice, {
      base_text: "Base",
      media_ids: [m2, m1, m2],
      scheduled_at: when,
      targets: [
        { social_account_id: a.ig.id, options: { ig_type: "feed" } },
        { social_account_id: a.fb.id, text_override: "FB text" },
        { social_account_id: a.fb.id }, // duplicate dropped
      ],
    });
    expect(post.status).toBe("scheduled");
    expect(post.scheduled_at).toBe(when);
    expect(post.media.map((m) => m.id)).toEqual([m2, m1]);
    expect(post.targets).toHaveLength(2);
    expect(post.targets[0]).toMatchObject({ platform: "instagram", status: "pending", next_attempt_at: when });
    expect(post.targets[1]).toMatchObject({ platform: "facebook", text_override: "FB text" });
    expect(post.targets[1].account_display_name).toContain("Alice");
    expect(getMediaItems(alice, [m1, m2]).map((m) => m.kind)).toEqual(["image", "image"]);
  });

  it("returns per-target validation errors keyed by account id", () => {
    const e = catchErr(() =>
      createPost(alice, {
        base_text: "no media",
        media_ids: [],
        scheduled_at: new Date().toISOString(),
        targets: [{ social_account_id: a.ig.id }, { social_account_id: a.li.id }],
      }),
    );
    expect(e).toBeInstanceOf(PostValidationError);
    const errs = (e as PostValidationError).errors;
    expect(errs[a.ig.id]?.length).toBeGreaterThan(0); // Instagram requires media
    expect(errs[a.li.id]).toBeUndefined();
    expect((e as PostValidationError).status).toBe(400);
  });

  it("rejects bad scheduled_at, empty targets, and foreign media", () => {
    const base = { base_text: "x", media_ids: [] as string[], targets: [{ social_account_id: a.li.id }] };
    expect(catchErr(() => createPost(alice, { ...base, scheduled_at: "not a date" }))).toBeInstanceOf(PostValidationError);
    expect(
      catchErr(() => createPost(alice, { ...base, scheduled_at: new Date(Date.now() - 3600_000).toISOString() })),
    ).toBeInstanceOf(PostValidationError);
    // 2 minutes in the past is accepted ("now" with clock skew).
    expect(createPost(alice, { ...base, scheduled_at: new Date(Date.now() - 120_000).toISOString() }).status).toBe("scheduled");
    expect(
      catchErr(() => createPost(alice, { ...base, targets: [], scheduled_at: new Date().toISOString() })),
    ).toBeInstanceOf(PostValidationError);
    // Drafts may have no targets and skip platform rules.
    expect(createPost(alice, { ...base, targets: [], scheduled_at: null }).status).toBe("draft");
    expect(createPost(alice, { ...base, targets: [{ social_account_id: a.ig.id }], scheduled_at: null }).status).toBe("draft");

    const bobMedia = insertMedia(bob, "image/jpeg");
    const e = catchErr(() =>
      createPost(alice, { ...base, media_ids: [bobMedia], scheduled_at: new Date().toISOString() }),
    ) as PostValidationError;
    expect(e).toBeInstanceOf(PostValidationError);
    expect(e.errors._post?.[0]).toMatch(/media/i);
  });

  it("isolates users: no reading, editing, deleting or targeting another user's data", () => {
    const post = createPost(alice, {
      base_text: "Alice's",
      media_ids: [],
      scheduled_at: new Date(Date.now() + 60_000).toISOString(),
      targets: [{ social_account_id: a.li.id }],
    });

    expect(getPost(bob, post.id)).toBeNull();
    expect(listPosts(bob)).toHaveLength(0);
    expect(listPosts(alice)).toHaveLength(1);
    expect(deletePost(bob, post.id)).toBe(false);
    expect((catchErr(() => updatePost(bob, post.id, { base_text: "pwned" })) as HttpError).status).toBe(404);
    expect((catchErr(() => retryFailed(bob, post.id)) as HttpError).status).toBe(404);
    expect((catchErr(() => publishNow(bob, post.id)) as HttpError).status).toBe(404);
    expect(getPost(alice, post.id)!.base_text).toBe("Alice's");

    // Bob can't target Alice's account.
    const e = catchErr(() =>
      createPost(bob, {
        base_text: "hi",
        media_ids: [],
        scheduled_at: new Date().toISOString(),
        targets: [{ social_account_id: a.li.id }],
      }),
    ) as PostValidationError;
    expect(e).toBeInstanceOf(PostValidationError);
    expect(e.errors[a.li.id]).toEqual(["Account not found"]);
    // ...not even in a draft, nor by editing his own post.
    expect(
      catchErr(() => createPost(bob, { base_text: "d", media_ids: [], scheduled_at: null, targets: [{ social_account_id: a.fb.id }] })),
    ).toBeInstanceOf(PostValidationError);
    const bobPost = createPost(bob, { base_text: "b", media_ids: [], scheduled_at: null, targets: [{ social_account_id: b.li.id }] });
    expect(
      catchErr(() => updatePost(bob, bobPost.id, { targets: [{ social_account_id: a.li.id }] })),
    ).toBeInstanceOf(PostValidationError);

    expect(deletePost(alice, post.id)).toBe(true);
    expect(getPost(alice, post.id)).toBeNull();
  });

  it("lists posts within a date range", () => {
    const h = 3600_000;
    const now = Date.now();
    const mk = (offset: number) =>
      createPost(alice, {
        base_text: `at ${offset}`,
        media_ids: [],
        scheduled_at: new Date(now + offset).toISOString(),
        targets: [{ social_account_id: a.li.id }],
      });
    const p1 = mk(1 * h);
    const p2 = mk(5 * h);
    mk(48 * h);
    const inRange = listPosts(alice, new Date(now).toISOString(), new Date(now + 24 * h).toISOString());
    expect(inRange.map((p) => p.id)).toEqual([p1.id, p2.id]);
    expect(() => listPosts(alice, "garbage")).toThrow(HttpError);
  });

  it("updates a post, rebuilding targets, and refuses once publishing started", () => {
    const post = createPost(alice, { base_text: "draft", media_ids: [], scheduled_at: null, targets: [{ social_account_id: a.li.id }] });
    const when = new Date(Date.now() + 600_000).toISOString();
    const upd = updatePost(alice, post.id, { scheduled_at: when, targets: [{ social_account_id: a.li.id }, { social_account_id: a.fb.id }] });
    expect(upd.status).toBe("scheduled");
    expect(upd.targets.map((t) => t.next_attempt_at)).toEqual([when, when]);

    getDb().prepare("UPDATE post_targets SET status = 'published' WHERE id = ?").run(upd.targets[0].id);
    expect((catchErr(() => updatePost(alice, post.id, { base_text: "edit" })) as HttpError).status).toBe(409);
  });

  it("publishNow makes pending targets due now and validates drafts", () => {
    const draft = createPost(alice, { base_text: "d", media_ids: [], scheduled_at: null, targets: [{ social_account_id: a.ig.id }] });
    expect(catchErr(() => publishNow(alice, draft.id))).toBeInstanceOf(PostValidationError); // IG needs media

    const later = createPost(alice, {
      base_text: "later",
      media_ids: [],
      scheduled_at: new Date(Date.now() + 86400_000).toISOString(),
      targets: [{ social_account_id: a.li.id }],
    });
    const now = new Date();
    const p = publishNow(alice, later.id, now);
    expect(p.scheduled_at).toBe(now.toISOString());
    expect(p.targets[0].next_attempt_at).toBe(now.toISOString());
    expect(p.status).toBe("scheduled");
  });

  it("recomputes post status from target statuses", () => {
    const post = createPost(alice, {
      base_text: "x",
      media_ids: [],
      scheduled_at: new Date().toISOString(),
      targets: [{ social_account_id: a.li.id }, { social_account_id: a.fb.id }],
    });
    const [t1, t2] = post.targets;
    const set = (id: string, s: string, attempts = 0) =>
      getDb().prepare("UPDATE post_targets SET status = ?, attempts = ? WHERE id = ?").run(s, attempts, id);
    // [status1, attempts1, status2, attempts2, expected]
    const cases: [string, number, string, number, string][] = [
      ["pending", 0, "pending", 0, "scheduled"],
      ["pending", 1, "pending", 0, "publishing"], // all pending, one retrying
      ["pending", 2, "pending", 1, "publishing"],
      ["publishing", 0, "pending", 0, "publishing"],
      ["published", 1, "pending", 0, "publishing"], // already partly out
      ["published", 1, "pending", 1, "publishing"],
      ["failed", 1, "pending", 0, "publishing"],
      ["published", 1, "publishing", 0, "publishing"],
      ["published", 1, "published", 1, "published"],
      ["failed", 1, "failed", 4, "failed"],
      ["published", 1, "failed", 1, "partial"],
    ];
    for (const [s1, a1, s2, a2, expected] of cases) {
      set(t1.id, s1, a1);
      set(t2.id, s2, a2);
      expect(recomputePostStatus(post.id), `${s1}/${a1} + ${s2}/${a2}`).toBe(expected);
      expect(getPost(alice, post.id)!.status).toBe(expected);
    }
    expect(recomputePostStatus("nope")).toBeNull();
  });
});
