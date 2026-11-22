import crypto from "node:crypto";
import { PublishError, type AccountWithTokens, type Platform, type Provider, type PublishContent, type PublishResult } from "../types";
import type { ConnectedAccount } from "./types";
import { validateContent } from "./rules";
import { sleep } from "./http";

// Simulated accounts + publishing so the whole app runs locally with zero API keys.
// No network calls happen here.

export const DEMO_TOKEN = "demo-token";

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24) || "user"
  );
}

function demoAccount(platform: Platform, id: string, display: string, meta: Record<string, unknown> = {}): ConnectedAccount {
  return {
    platform,
    platform_account_id: id,
    display_name: display,
    avatar_url: null,
    access_token: DEMO_TOKEN,
    refresh_token: null,
    token_expires_at: null,
    scopes: "demo",
    meta: { demo: true, ...meta },
  };
}

/** Stable ids per provider so reconnecting upserts instead of duplicating. */
export function demoAccountsFor(p: Provider, userName: string): ConnectedAccount[] {
  const name = userName.trim() || "Demo User";
  const handle = slug(name);
  switch (p) {
    case "meta":
      return [
        demoAccount("facebook", "demo_fb_page_1", `${name}'s Page (demo)`, { page_id: "demo_fb_page_1" }),
        demoAccount("instagram", "demo_ig_1", `@${handle}_demo (demo)`, { page_id: "demo_fb_page_1", username: `${handle}_demo` }),
      ];
    case "linkedin":
      return [demoAccount("linkedin", "urn:li:person:demo_li_1", `${name} (demo)`, { kind: "person" })];
    case "google":
      return [demoAccount("youtube", "demo_yt_channel_1", `${name} Channel (demo)`)];
    case "tiktok":
      return [demoAccount("tiktok", "demo_tt_1", `@${handle}_demo (demo)`, { username: `${handle}_demo` })];
  }
}

function demoDelayMs(): number {
  const v = Number(process.env.DEMO_PUBLISH_DELAY_MS);
  return Number.isFinite(v) && v >= 0 ? v : 800;
}

/** Simulated publish: validates, waits ~800ms, honours #fatal / #fail markers. */
export async function demoPublish(account: AccountWithTokens, c: PublishContent): Promise<PublishResult> {
  const problems = validateContent(account.platform, c);
  if (problems.length) throw new PublishError(problems.join(" "), false);
  await sleep(demoDelayMs());
  const text = c.text ?? "";
  if (text.includes("#fatal")) throw new PublishError("Demo: simulated permanent failure (#fatal)", false);
  if (text.includes("#fail")) throw new PublishError("Demo: simulated temporary failure (#fail)", true);
  const id = `demo_${account.platform}_${crypto.randomBytes(6).toString("hex")}`;
  return { platform_post_id: id, platform_post_url: `https://example.com/demo/${account.platform}/${id}` };
}
