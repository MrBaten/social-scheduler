import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, newId, nowIso, resetDbForTests } from "../lib/db";
import { demoAccountsFor } from "../lib/platforms";
import { saveConnectedAccounts } from "../lib/accounts";
import { createPost, getPost, retryFailed } from "../lib/posts";
import { BACKOFF_MS, HEARTBEAT_MS, MAX_ATTEMPTS, processDuePosts } from "../lib/scheduler";
import type { SocialAccountPublic } from "../lib/types";

// Demo publish waits DEMO_PUBLISH_DELAY_MS (default 800ms); keep tests quick.
process.env.DEMO_PUBLISH_DELAY_MS = "20";

function makeUser(name = "Alice"): string {
  const id = newId("u_");
  getDb()
    .prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, 'x', ?)")
    .run(id, `${id}@example.com`, name, nowIso());
  return id;
}

function demoAccounts(userId: string): { fb: SocialAccountPublic; li: SocialAccountPublic } {
  const meta = saveConnectedAccounts(userId, "meta", demoAccountsFor("meta", "Alice"), true);
  const li = saveConnectedAccounts(userId, "linkedin", demoAccountsFor("linkedin", "Alice"), true);
  return { fb: meta.find((a) => a.platform === "facebook")!, li: li[0] };
}

const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

describe("processDuePosts", () => {
  let userId: string;
  let fb: SocialAccountPublic;
  let li: SocialAccountPublic;

  beforeEach(() => {
    resetDbForTests();
    userId = makeUser();
    ({ fb, li } = demoAccounts(userId));
  });

  it("publishes due demo targets and marks the post published", async () => {
    const t0 = new Date();
    const post = createPost(userId, {
      base_text: "Hello world",
      media_ids: [],
      scheduled_at: t0.toISOString(),
      targets: [{ social_account_id: fb.id }, { social_account_id: li.id, text_override: "Hello LinkedIn" }],
    });
    expect(post.status).toBe("scheduled");
    expect(post.targets.map((t) => t.status)).toEqual(["pending", "pending"]);

    const r = await processDuePosts(at(t0, 1000));
    expect(r).toEqual({ processed: 2, published: 2, failed: 0 });

    const after = getPost(userId, post.id)!;
    expect(after.status).toBe("published");
    for (const t of after.targets) {
      expect(t.status).toBe("published");
      expect(t.platform_post_id).toMatch(/^demo_/);
      expect(t.published_at).toBeTruthy();
      expect(t.last_error).toBeNull();
    }
    // Nothing left to do.
    expect(await processDuePosts(at(t0, 2000))).toEqual({ processed: 0, published: 0, failed: 0 });
  });

  it("does not publish future posts or drafts", async () => {
    const t0 = new Date();
    const future = createPost(userId, {
      base_text: "later",
      media_ids: [],
      scheduled_at: at(t0, 3600_000).toISOString(),
      targets: [{ social_account_id: li.id }],
    });
    const draft = createPost(userId, { base_text: "draft", media_ids: [], scheduled_at: null, targets: [{ social_account_id: li.id }] });
    expect(draft.status).toBe("draft");

    expect((await processDuePosts(at(t0, 1000))).processed).toBe(0);
    expect(getPost(userId, future.id)!.status).toBe("scheduled");
    expect(getPost(userId, draft.id)!.status).toBe("draft");

    const r = await processDuePosts(at(t0, 3600_000 + 1000));
    expect(r.published).toBe(1);
    expect(getPost(userId, future.id)!.status).toBe("published");
    expect(getPost(userId, draft.id)!.status).toBe("draft");
  });

  it("#fail retries with backoff and fails after MAX_ATTEMPTS", async () => {
    expect(MAX_ATTEMPTS).toBe(4);
    const t0 = new Date();
    const post = createPost(userId, {
      base_text: "flaky #fail",
      media_ids: [],
      scheduled_at: t0.toISOString(),
      targets: [{ social_account_id: li.id }],
    });

    let now = at(t0, 1000);
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      const r = await processDuePosts(now);
      expect(r).toEqual({ processed: 1, published: 0, failed: 0 });
      const t = getPost(userId, post.id)!.targets[0];
      expect(t.status).toBe("pending");
      expect(t.attempts).toBe(attempt);
      expect(t.last_error).toContain("#fail");
      expect(t.next_attempt_at).toBe(at(now, BACKOFF_MS[attempt - 1]).toISOString());
      // All targets pending, but one is mid-retry: the post is publishing, not scheduled.
      expect(getPost(userId, post.id)!.status).toBe("publishing");

      // Not due yet just before the backoff expires.
      expect((await processDuePosts(at(now, BACKOFF_MS[attempt - 1] - 1000))).processed).toBe(0);
      now = new Date(t.next_attempt_at!);
    }

    const last = await processDuePosts(now);
    expect(last).toEqual({ processed: 1, published: 0, failed: 1 });
    const p = getPost(userId, post.id)!;
    expect(p.status).toBe("failed");
    expect(p.targets[0].status).toBe("failed");
    expect(p.targets[0].attempts).toBe(MAX_ATTEMPTS);
    expect(p.targets[0].next_attempt_at).toBeNull();

    // Retry puts it back in the queue, due now, with a fresh attempt budget.
    const retried = retryFailed(userId, post.id, now);
    expect(retried.status).toBe("scheduled");
    expect(retried.targets[0]).toMatchObject({ status: "pending", attempts: 0, last_error: null });
    expect((await processDuePosts(now)).processed).toBe(1);
  }, 20_000);

  it("#fatal fails immediately without retry", async () => {
    const t0 = new Date();
    const post = createPost(userId, {
      base_text: "broken #fatal",
      media_ids: [],
      scheduled_at: t0.toISOString(),
      targets: [{ social_account_id: fb.id }],
    });
    const r = await processDuePosts(at(t0, 1000));
    expect(r).toEqual({ processed: 1, published: 0, failed: 1 });
    const p = getPost(userId, post.id)!;
    expect(p.status).toBe("failed");
    expect(p.targets[0]).toMatchObject({ status: "failed", attempts: 1, next_attempt_at: null });
    expect(p.targets[0].last_error).toContain("#fatal");
  });

  it("rolls up mixed results to partial", async () => {
    const t0 = new Date();
    const post = createPost(userId, {
      base_text: "good",
      media_ids: [],
      scheduled_at: t0.toISOString(),
      targets: [{ social_account_id: fb.id }, { social_account_id: li.id, text_override: "bad #fatal" }],
    });
    const r = await processDuePosts(at(t0, 1000));
    expect(r).toEqual({ processed: 2, published: 1, failed: 1 });
    const p = getPost(userId, post.id)!;
    expect(p.status).toBe("partial");
    const byAcct = Object.fromEntries(p.targets.map((t) => [t.social_account_id, t.status]));
    expect(byAcct).toEqual({ [fb.id]: "published", [li.id]: "failed" });
  });

  it("shows 'publishing' while one target waits for a retry", async () => {
    const t0 = new Date();
    const post = createPost(userId, {
      base_text: "ok",
      media_ids: [],
      scheduled_at: t0.toISOString(),
      targets: [{ social_account_id: fb.id }, { social_account_id: li.id, text_override: "later #fail" }],
    });
    await processDuePosts(at(t0, 1000));
    expect(getPost(userId, post.id)!.status).toBe("publishing");
  });

  it("shows 'publishing' when every target is pending but one is retrying", async () => {
    const t0 = new Date();
    const post = createPost(userId, {
      base_text: "both flaky #fail",
      media_ids: [],
      scheduled_at: t0.toISOString(),
      targets: [{ social_account_id: fb.id }, { social_account_id: li.id }],
    });
    await processDuePosts(at(t0, 1000));
    const p = getPost(userId, post.id)!;
    expect(p.targets.map((t) => [t.status, t.attempts])).toEqual([
      ["pending", 1],
      ["pending", 1],
    ]);
    expect(p.status).toBe("publishing");
  });

  it("refreshes locked_at while a slow publish runs, so it isn't reclaimed as stale", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      process.env.DEMO_PUBLISH_DELAY_MS = "200";
      // Claim time (injected) is 2 min in the past, so a heartbeat (real clock) must move it forward.
      const t0 = new Date(Date.now() - 120_000);
      const post = createPost(userId, {
        base_text: "slow",
        media_ids: [],
        scheduled_at: t0.toISOString(),
        targets: [{ social_account_id: li.id }],
      });
      const run = processDuePosts(at(t0, 1000));
      // Let the claim happen, then fire one heartbeat.
      await new Promise((r) => setTimeout(r, 50));
      const before = getDb().prepare("SELECT status, locked_at FROM post_targets WHERE post_id = ?").get(post.id) as {
        status: string;
        locked_at: string;
      };
      expect(before.status).toBe("publishing");
      vi.advanceTimersByTime(HEARTBEAT_MS);
      const after = getDb().prepare("SELECT locked_at FROM post_targets WHERE post_id = ?").get(post.id) as { locked_at: string };
      expect(after.locked_at > before.locked_at).toBe(true);
      await run;
      expect(getPost(userId, post.id)!.status).toBe("published");
    } finally {
      process.env.DEMO_PUBLISH_DELAY_MS = "20";
      vi.useRealTimers();
    }
  });

  it("claims each target once even with overlapping runs", async () => {
    const t0 = new Date();
    const post = createPost(userId, {
      base_text: "once",
      media_ids: [],
      scheduled_at: t0.toISOString(),
      targets: [{ social_account_id: fb.id }, { social_account_id: li.id }],
    });
    const [a, b] = await Promise.all([processDuePosts(at(t0, 1000)), processDuePosts(at(t0, 1000))]);
    expect(a.published).toBe(2);
    expect(b.published).toBe(2); // second caller joined the same run
    const ids = new Set(getPost(userId, post.id)!.targets.map((t) => t.platform_post_id));
    expect(ids.size).toBe(2);
  });

  it("reclaims targets stuck in 'publishing' for over 15 minutes", async () => {
    const t0 = new Date();
    const post = createPost(userId, {
      base_text: "stuck",
      media_ids: [],
      scheduled_at: t0.toISOString(),
      targets: [{ social_account_id: li.id }],
    });
    getDb()
      .prepare("UPDATE post_targets SET status = 'publishing', locked_at = ? WHERE post_id = ?")
      .run(t0.toISOString(), post.id);

    expect((await processDuePosts(at(t0, 10 * 60_000))).processed).toBe(0); // lock still fresh
    const r = await processDuePosts(at(t0, 16 * 60_000));
    expect(r.published).toBe(1);
    expect(getPost(userId, post.id)!.status).toBe("published");
  });
});
