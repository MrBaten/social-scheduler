import { config } from "../config";
import { PublishError, type AccountWithTokens, type MediaItem, type PublishContent, type PublishResult } from "../types";
import type { ConnectedAccount, PlatformPublisher, ProviderAdapter } from "./types";
import { PLATFORM_RULES, validateContent } from "./rules";
import { form, httpJson, noRetryIfUncertain, poll } from "./http";

// Meta (Facebook Login) -> Facebook Pages + linked Instagram professional accounts.
//
// Flow: dialog/oauth -> code -> short-lived user token -> long-lived user token (fb_exchange_token,
// ~60 days) -> /me/accounts gives Page access tokens. Page tokens obtained from a long-lived user
// token don't expire (unless the user changes password / revokes), so we store expiry = null and
// no refresh. Instagram publishing with Facebook Login uses graph.facebook.com + the Page token.
//
// IMPORTANT: Facebook /photos `url`, /videos `file_url` and every Instagram image_url/video_url are
// fetched by Meta's servers, so media must be on a public URL (config.publicMediaBaseUrl).

const SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "business_management",
];

const graphBase = () => `https://graph.facebook.com/${config.meta.graphVersion}`;
// Page video publishing uses the graph-video host (still documented in Meta's Video API publishing
// guide, checked 2026-11); /{page-id}/videos lists `file_url` ("Accessible URL of a video file").
const graphVideoBase = () => `https://graph-video.facebook.com/${config.meta.graphVersion}`;

async function graphGet<T = any>(path: string, params: Record<string, string>, label: string): Promise<T> {
  const url = `${graphBase()}${path}?${new URLSearchParams(params)}`;
  return (await httpJson<T>(url, { label })).data;
}

async function graphPost<T = any>(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  label: string,
  base = graphBase(),
  timeoutMs?: number,
): Promise<T> {
  return (
    await httpJson<T>(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form(params),
      label,
      timeoutMs,
    })
  ).data;
}

// ---------------------------------------------------------------------------------------------
// Provider (OAuth)
// ---------------------------------------------------------------------------------------------

interface MePage {
  id: string;
  name: string;
  access_token: string;
  picture?: { data?: { url?: string } };
  instagram_business_account?: { id: string; username?: string; profile_picture_url?: string };
}

export const metaProvider: ProviderAdapter = {
  provider: "meta",
  label: "Meta (Facebook + Instagram)",
  usesPkce: false,
  getAuthUrl({ state, redirectUri }) {
    const p = new URLSearchParams({
      client_id: config.meta.appId,
      redirect_uri: redirectUri,
      state,
      response_type: "code",
      scope: SCOPES.join(","),
    });
    return `https://www.facebook.com/${config.meta.graphVersion}/dialog/oauth?${p}`;
  },
  async exchangeCode({ code, redirectUri }) {
    const label = "Meta";
    const short = await graphGet<{ access_token: string }>(
      "/oauth/access_token",
      { client_id: config.meta.appId, client_secret: config.meta.appSecret, redirect_uri: redirectUri, code },
      label,
    );
    const long = await graphGet<{ access_token: string; expires_in?: number }>(
      "/oauth/access_token",
      {
        grant_type: "fb_exchange_token",
        client_id: config.meta.appId,
        client_secret: config.meta.appSecret,
        fb_exchange_token: short.access_token,
      },
      label,
    );

    const pages: MePage[] = [];
    let next: string | null =
      `${graphBase()}/me/accounts?` +
      new URLSearchParams({
        fields: "id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}",
        limit: "100",
        access_token: long.access_token,
      });
    for (let i = 0; next && i < 10; i++) {
      const res: { data: { data: MePage[]; paging?: { next?: string } } } = await httpJson(next, { label });
      pages.push(...(res.data.data ?? []));
      next = res.data.paging?.next ?? null;
    }
    if (pages.length === 0) {
      throw new Error("No Facebook Pages found. Make sure you selected at least one Page when connecting.");
    }

    const scopes = SCOPES.join(",");
    const out: ConnectedAccount[] = [];
    for (const page of pages) {
      out.push({
        platform: "facebook",
        platform_account_id: page.id,
        display_name: page.name,
        avatar_url: page.picture?.data?.url ?? null,
        access_token: page.access_token,
        refresh_token: null,
        token_expires_at: null, // Page tokens derived from a long-lived user token don't expire.
        scopes,
        meta: { page_id: page.id },
      });
      const ig = page.instagram_business_account;
      if (ig?.id) {
        out.push({
          platform: "instagram",
          platform_account_id: ig.id,
          display_name: ig.username ? `@${ig.username}` : `Instagram (${page.name})`,
          avatar_url: ig.profile_picture_url ?? null,
          access_token: page.access_token, // IG Graph API via Facebook Login accepts the Page token.
          refresh_token: null,
          token_expires_at: null,
          scopes,
          meta: { page_id: page.id, page_name: page.name, username: ig.username ?? null },
        });
      }
    }
    return out;
  },
  // No refresh(): Page tokens don't expire; if revoked, the user must reconnect.
};

// ---------------------------------------------------------------------------------------------
// Facebook Page publisher
// ---------------------------------------------------------------------------------------------

function assertValid(platform: "facebook" | "instagram", c: PublishContent) {
  const problems = validateContent(platform, c);
  if (problems.length) throw new PublishError(problems.join(" "), false);
}

export const facebookPublisher: PlatformPublisher = {
  platform: "facebook",
  rules: PLATFORM_RULES.facebook,
  validate: (c) => validateContent("facebook", c),
  async publish(account: AccountWithTokens, c: PublishContent): Promise<PublishResult> {
    assertValid("facebook", c);
    const label = "Facebook";
    const pageId = account.platform_account_id;
    const token = account.access_token;
    const images = c.media.filter((m) => m.kind === "image");
    const video = c.media.find((m) => m.kind === "video");

    if (video) {
      // Single video: Meta downloads it from file_url.
      const r = await noRetryIfUncertain(label, () =>
        graphPost<{ id: string }>(
          `/${pageId}/videos`,
          { file_url: video.public_url, description: c.text || undefined, access_token: token },
          label,
          graphVideoBase(),
          120_000,
        ),
      );
      return { platform_post_id: r.id, platform_post_url: `https://www.facebook.com/${pageId}/videos/${r.id}` };
    }

    if (images.length === 1) {
      const r = await noRetryIfUncertain(label, () =>
        graphPost<{ id: string; post_id?: string }>(
          `/${pageId}/photos`,
          { url: images[0].public_url, caption: c.text || undefined, access_token: token },
          label,
          undefined,
          60_000,
        ),
      );
      const id = r.post_id ?? r.id;
      return { platform_post_id: id, platform_post_url: `https://www.facebook.com/${id}` };
    }

    const params: Record<string, string | undefined> = { message: c.text || undefined, access_token: token };
    if (images.length > 1) {
      // Multi-photo: upload each as unpublished photo, then attach to one feed post.
      for (let i = 0; i < images.length; i++) {
        const p = await graphPost<{ id: string }>(
          `/${pageId}/photos`,
          { url: images[i].public_url, published: false, access_token: token },
          label,
          undefined,
          60_000,
        );
        params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: p.id });
      }
    } else if (c.options.link) {
      params.link = c.options.link;
    }
    const r = await noRetryIfUncertain(label, () => graphPost<{ id: string }>(`/${pageId}/feed`, params, label));
    return { platform_post_id: r.id, platform_post_url: `https://www.facebook.com/${r.id}` };
  },
};

// ---------------------------------------------------------------------------------------------
// Instagram publisher (container -> wait FINISHED -> media_publish)
// ---------------------------------------------------------------------------------------------

const IG_POLL_TIMEOUT_MS = 5 * 60_000;

async function waitForContainer(containerId: string, token: string, isVideo: boolean): Promise<void> {
  const label = "Instagram";
  const status = await poll(
    async () => {
      const r = await graphGet<{ status_code?: string; status?: string }>(
        `/${containerId}`,
        { fields: "status_code,status", access_token: token },
        label,
      );
      switch (r.status_code) {
        case "FINISHED":
        case "PUBLISHED":
          return "ok" as const;
        case "ERROR":
          throw new PublishError(`Instagram: media processing failed${r.status ? ` (${r.status})` : ""}`, false);
        case "EXPIRED":
          throw new PublishError("Instagram: media container expired before publishing", true);
        default:
          return undefined; // IN_PROGRESS
      }
    },
    { intervalMs: isVideo ? 5000 : 2000, timeoutMs: IG_POLL_TIMEOUT_MS },
  );
  // Nothing was published yet, so retrying (with a fresh container) is safe.
  if (!status) throw new PublishError("Instagram: timed out waiting for media processing", true);
}

async function createContainer(igUserId: string, token: string, params: Record<string, string | boolean | undefined>) {
  const r = await graphPost<{ id: string }>(`/${igUserId}/media`, { ...params, access_token: token }, "Instagram", undefined, 60_000);
  return r.id;
}

function mediaParams(m: MediaItem): Record<string, string> {
  return m.kind === "video" ? { video_url: m.public_url } : { image_url: m.public_url };
}

export const instagramPublisher: PlatformPublisher = {
  platform: "instagram",
  rules: PLATFORM_RULES.instagram,
  validate: (c) => validateContent("instagram", c),
  async publish(account: AccountWithTokens, c: PublishContent): Promise<PublishResult> {
    assertValid("instagram", c);
    const igId = account.platform_account_id;
    const token = account.access_token;
    const type = c.options.ig_type ?? "feed";
    const caption = c.text || undefined;
    let containerId: string;
    let anyVideo = c.media.some((m) => m.kind === "video");

    if (type === "story") {
      // Stories ignore captions.
      containerId = await createContainer(igId, token, { media_type: "STORIES", ...mediaParams(c.media[0]) });
    } else if (c.media.length === 1) {
      const m = c.media[0];
      if (m.kind === "video") {
        // Feed videos are published as Reels (media_type VIDEO for feed is deprecated).
        // VERIFY: share_to_feed isn't documented on the current content-publishing page; it was
        // historically used to show the reel in both Feed and Reels tabs. Harmless if ignored.
        containerId = await createContainer(igId, token, {
          media_type: "REELS",
          video_url: m.public_url,
          caption,
          share_to_feed: type === "feed" ? true : undefined,
        });
      } else {
        containerId = await createContainer(igId, token, { image_url: m.public_url, caption });
      }
    } else {
      // Carousel: child containers (images and videos may be mixed), then a CAROUSEL container.
      const children: string[] = [];
      for (const m of c.media) {
        const id = await createContainer(igId, token, {
          ...(m.kind === "video" ? { media_type: "VIDEO" } : {}),
          ...mediaParams(m),
          is_carousel_item: true,
        });
        children.push(id);
      }
      for (let i = 0; i < children.length; i++) {
        await waitForContainer(children[i], token, c.media[i].kind === "video");
      }
      containerId = await createContainer(igId, token, { media_type: "CAROUSEL", children: children.join(","), caption });
      anyVideo = false; // carousel container itself finishes quickly once children are done
    }

    await waitForContainer(containerId, token, anyVideo);
    const pub = await noRetryIfUncertain("Instagram", () =>
      graphPost<{ id: string }>(
        `/${igId}/media_publish`,
        { creation_id: containerId, access_token: token },
        "Instagram",
        undefined,
        60_000,
      ),
    );

    let url: string | null = null;
    try {
      const r = await graphGet<{ permalink?: string }>(`/${pub.id}`, { fields: "permalink", access_token: token }, "Instagram");
      url = r.permalink ?? null;
    } catch {
      // Published already; a missing permalink shouldn't fail (and retry) the post.
    }
    return { platform_post_id: pub.id, platform_post_url: url };
  },
};

