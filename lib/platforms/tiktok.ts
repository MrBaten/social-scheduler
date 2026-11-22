import fs from "node:fs";
import { config } from "../config";
import { PublishError, type AccountWithTokens, type PublishContent, type PublishResult, type TargetOptions } from "../types";
import type { PlatformPublisher, ProviderAdapter, TokenRefreshResult } from "./types";
import { PLATFORM_RULES, validateContent } from "./rules";
import { errorFromResponse, expiresAtFromSeconds, form, http, httpJson, noRetryIfUncertain, poll } from "./http";

// TikTok Login Kit (web) + Content Posting API (Direct Post).
//
// PKCE: TikTok's docs (checked 2026-11) say code_verifier is "Required for mobile and desktop
// apps"; the Login Kit for Web page lists no code_challenge param. So the web flow here doesn't
// use PKCE. If you register a desktop app, set usesPkce=true (the start/callback routes handle it).
//
// AUDIT: until the app passes TikTok's Content Posting audit, posts are restricted to SELF_ONLY
// (private) visibility and can only be made to *private* accounts; init otherwise fails with
// `unaudited_client_can_only_post_to_private_accounts`.
//
// Access tokens are short-lived (hours; we trust expires_in) and refresh tokens (~180 days)
// rotate on every refresh, so the new refresh_token must be persisted.

const API = "https://open.tiktokapis.com";
const SCOPES = ["user.info.basic", "video.publish"];
const label = "TikTok";

interface TikTokToken {
  access_token: string;
  expires_in?: number;
  open_id: string;
  refresh_token?: string;
  refresh_expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TikTokToken> {
  const { data } = await httpJson<TikTokToken>(`${API}/v2/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: form({ ...params, client_key: config.tiktok.clientKey, client_secret: config.tiktok.clientSecret }),
    label,
  });
  // TikTok can return 200 with { error, error_description }.
  if (data.error || !data.access_token) {
    const tokenIssue = data.error === "invalid_grant";
    throw new PublishError(`TikTok: ${data.error_description || data.error || "token request failed"}`, false, tokenIssue);
  }
  return data;
}

/** TikTok API responses carry { data, error: { code, message, log_id } }; code "ok" means success. */
async function tiktokApi<T>(path: string, token: string, body?: unknown, method = "POST"): Promise<T> {
  return (await tiktokApiRaw<T>(path, token, body, method)).data;
}

async function tiktokApiRaw<T>(path: string, token: string, body?: unknown, method = "POST"): Promise<{ data: T; raw: string }> {
  const res = await http(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
    body: body === undefined ? undefined : JSON.stringify(body),
    label,
  });
  const raw = await res.text();
  let data: { data: T; error?: { code?: string; message?: string; log_id?: string } };
  try {
    data = JSON.parse(raw);
  } catch {
    throw new PublishError("TikTok: invalid JSON response", true);
  }
  if (data.error && data.error.code && data.error.code !== "ok") {
    // Reuse the shared classifier (access_token_invalid -> tokenExpired, rate limit -> retryable).
    const e = errorFromResponse(label, 200, JSON.stringify({ error: data.error }));
    if (data.error.code === "unaudited_client_can_only_post_to_private_accounts") {
      e.message = "TikTok: this app is unaudited and can only post to private accounts (set your TikTok account to private).";
    }
    if (data.error.code.startsWith("spam_risk") || data.error.code === "reached_active_user_cap") e.retryable = false;
    throw e;
  }
  return { data: data.data, raw };
}

export const tiktokProvider: ProviderAdapter = {
  provider: "tiktok",
  label: "TikTok",
  usesPkce: false,
  getAuthUrl({ state, redirectUri, codeChallenge }) {
    const p = new URLSearchParams({
      client_key: config.tiktok.clientKey,
      response_type: "code",
      scope: SCOPES.join(","),
      redirect_uri: redirectUri,
      state,
    });
    if (codeChallenge) {
      p.set("code_challenge", codeChallenge);
      p.set("code_challenge_method", "S256");
    }
    return `https://www.tiktok.com/v2/auth/authorize/?${p}`;
  },
  async exchangeCode({ code, redirectUri, codeVerifier }) {
    const params: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: redirectUri };
    if (codeVerifier) params.code_verifier = codeVerifier;
    const tok = await tokenRequest(params);
    const user = await tiktokApi<{ user?: { open_id?: string; display_name?: string; avatar_url?: string } }>(
      "/v2/user/info/?fields=open_id,avatar_url,display_name",
      tok.access_token,
      undefined,
      "GET",
    );
    return [
      {
        platform: "tiktok",
        platform_account_id: tok.open_id,
        display_name: user?.user?.display_name || "TikTok user",
        avatar_url: user?.user?.avatar_url ?? null,
        access_token: tok.access_token,
        refresh_token: tok.refresh_token ?? null,
        token_expires_at: expiresAtFromSeconds(tok.expires_in),
        scopes: tok.scope ?? SCOPES.join(","),
        meta: { refresh_expires_at: expiresAtFromSeconds(tok.refresh_expires_in) },
      },
    ];
  },
  async refresh(account: AccountWithTokens): Promise<TokenRefreshResult> {
    if (!account.refresh_token) throw new PublishError("TikTok: no refresh token; reconnect the account", false, true);
    const tok = await tokenRequest({ grant_type: "refresh_token", refresh_token: account.refresh_token });
    return {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? null, // rotates: the old one is invalidated
      token_expires_at: expiresAtFromSeconds(tok.expires_in),
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------------------------

type TikTokPrivacy = "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";

interface CreatorInfo {
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options?: TikTokPrivacy[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
}

/**
 * Map composer privacy -> TikTok privacy_level. TikTok's UX guidelines want the user to pick
 * explicitly; with no choice we default to SELF_ONLY (the only option for unaudited apps).
 * "friends" maps to MUTUAL_FOLLOW_FRIENDS, or FOLLOWER_OF_CREATOR for private accounts.
 */
function pickPrivacy(opt: TargetOptions["privacy"], allowed: TikTokPrivacy[]): TikTokPrivacy {
  let wanted: TikTokPrivacy[];
  switch (opt) {
    case "public":
      wanted = ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR"];
      break;
    case "friends":
      wanted = ["MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR"];
      break;
    default:
      wanted = ["SELF_ONLY"];
  }
  const hit = wanted.find((w) => allowed.includes(w));
  if (!hit) {
    throw new PublishError(`TikTok: privacy "${opt ?? "self_only"}" isn't available for this account (allowed: ${allowed.join(", ") || "none"}).`, false);
  }
  return hit;
}

/** Best-effort MP4/MOV duration from the moov/mvhd box (no ffprobe). Returns null if unknown. */
export async function mp4DurationSec(path: string): Promise<number | null> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(path, "r");
    const size = (await fh.stat()).size;
    const hdr = Buffer.alloc(16);
    const findBox = async (start: number, end: number, type: string): Promise<{ at: number; size: number; hdr: number } | null> => {
      let pos = start;
      while (pos + 8 <= end) {
        await fh!.read(hdr, 0, 16, pos);
        let boxSize = hdr.readUInt32BE(0);
        const boxType = hdr.toString("latin1", 4, 8);
        let headerLen = 8;
        if (boxSize === 1) {
          boxSize = Number(hdr.readBigUInt64BE(8));
          headerLen = 16;
        } else if (boxSize === 0) boxSize = end - pos;
        if (boxSize < headerLen) return null;
        if (boxType === type) return { at: pos, size: boxSize, hdr: headerLen };
        pos += boxSize;
      }
      return null;
    };
    const moov = await findBox(0, size, "moov");
    if (!moov) return null;
    const mvhd = await findBox(moov.at + moov.hdr, moov.at + moov.size, "mvhd");
    if (!mvhd) return null;
    const b = Buffer.alloc(32);
    await fh.read(b, 0, 32, mvhd.at + mvhd.hdr);
    const version = b.readUInt8(0);
    const [timescale, duration] =
      version === 1 ? [b.readUInt32BE(20), Number(b.readBigUInt64BE(24))] : [b.readUInt32BE(12), b.readUInt32BE(16)];
    return timescale ? duration / timescale : null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/** FILE_UPLOAD chunking per TikTok's media transfer guide: chunks 5–64 MB, last chunk may be up to
 *  128 MB, files <= 64 MB go in one chunk, total_chunk_count = floor(size / chunk_size). */
function chunkPlan(size: number): { chunkSize: number; count: number } {
  const MB = 1024 * 1024;
  if (size <= 64 * MB) return { chunkSize: size, count: 1 };
  const chunkSize = 10 * MB;
  return { chunkSize, count: Math.floor(size / chunkSize) };
}

function useFileUpload(): boolean {
  // PULL_FROM_URL only works for URL prefixes/domains verified in the TikTok developer portal
  // (otherwise init fails with 403 url_ownership_unverified). FILE_UPLOAD works everywhere, so it's
  // the default for videos; set TIKTOK_VIDEO_SOURCE=PULL_FROM_URL once PUBLIC_MEDIA_BASE_URL's
  // domain is verified. (Photo posts only support PULL_FROM_URL, so they always need verification.)
  return process.env.TIKTOK_VIDEO_SOURCE !== "PULL_FROM_URL";
}

/** TikTok reported status FAILED: nothing went live, so its own retryable flag stands. */
class TikTokPublishFailed extends PublishError {}

/** Run the status poll; any other retryable error after init becomes final (see comment at call site). */
async function pollPublishStatus<T>(publishId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TikTokPublishFailed || (err instanceof PublishError && !err.retryable)) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new PublishError(
      `${msg} (while checking publish_id ${publishId}; the post may still go live, check the TikTok app before retrying)`,
      false,
    );
  }
}

export const tiktokPublisher: PlatformPublisher = {
  platform: "tiktok",
  rules: PLATFORM_RULES.tiktok,
  validate: (c) => validateContent("tiktok", c),
  async publish(account: AccountWithTokens, c: PublishContent): Promise<PublishResult> {
    const problems = validateContent("tiktok", c);
    if (problems.length) throw new PublishError(problems.join(" "), false);
    const token = account.access_token;

    // 1) Creator info: must be queried before every post (privacy options, limits).
    const info = await tiktokApi<CreatorInfo>("/v2/post/publish/creator_info/query/", token, {});
    const privacy = pickPrivacy(c.options.privacy, info.privacy_level_options ?? []);
    const video = c.media.find((m) => m.kind === "video");
    let publishId: string;

    if (video) {
      const max = info.max_video_post_duration_sec;
      if (max) {
        const dur = await mp4DurationSec(video.path);
        if (dur !== null && dur > max) {
          throw new PublishError(`TikTok: video is ${Math.round(dur)}s; this account can post up to ${max}s.`, false);
        }
      }
      const post_info = {
        title: c.text ?? "",
        privacy_level: privacy,
        disable_comment: info.comment_disabled ?? false,
        disable_duet: info.duet_disabled ?? false,
        disable_stitch: info.stitch_disabled ?? false,
        // Commercial content disclosure; the Direct Post reference lists brand_content_toggle as required.
        brand_content_toggle: false,
        brand_organic_toggle: false,
      };
      if (useFileUpload()) {
        const size = (await fs.promises.stat(video.path)).size;
        const { chunkSize, count } = chunkPlan(size);
        const init = await tiktokApi<{ publish_id: string; upload_url: string }>("/v2/post/publish/video/init/", token, {
          post_info,
          source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: chunkSize, total_chunk_count: count },
        });
        publishId = init.publish_id;
        const fh = await fs.promises.open(video.path, "r");
        try {
          for (let i = 0; i < count; i++) {
            const first = i * chunkSize;
            const last = i === count - 1 ? size - 1 : first + chunkSize - 1; // last chunk absorbs the remainder
            const buf = Buffer.alloc(last - first + 1);
            await fh.read(buf, 0, buf.length, first);
            const put = () =>
              http(init.upload_url, {
                method: "PUT",
                headers: {
                  "Content-Type": video.mime_type,
                  "Content-Length": String(buf.length),
                  "Content-Range": `bytes ${first}-${last}/${size}`,
                },
                body: buf,
                label,
                timeoutMs: 300_000,
              });
            // Once the last chunk lands TikTok publishes on its own; a lost response there must not
            // trigger a re-post.
            await (i === count - 1 ? noRetryIfUncertain(label, put) : put());
          }
        } finally {
          await fh.close();
        }
      } else {
        // With PULL_FROM_URL, init itself starts the post: don't auto-retry if its response is lost.
        const init = await noRetryIfUncertain(label, () =>
          tiktokApi<{ publish_id: string }>("/v2/post/publish/video/init/", token, {
            post_info,
            source_info: { source: "PULL_FROM_URL", video_url: video.public_url },
          }),
        );
        publishId = init.publish_id;
      }
    } else {
      // Photo post (1–35 JPEG/WebP images, always PULL_FROM_URL from a verified domain).
      const init = await noRetryIfUncertain(label, () => tiktokApi<{ publish_id: string }>("/v2/post/publish/content/init/", token, {
        post_mode: "DIRECT_POST",
        media_type: "PHOTO",
        post_info: {
          ...(c.options.title ? { title: c.options.title.slice(0, 90) } : {}),
          description: c.text ?? "",
          privacy_level: privacy,
          disable_comment: info.comment_disabled ?? false,
          auto_add_music: true,
          brand_content_toggle: false,
          brand_organic_toggle: false,
        },
        source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: c.media.map((m) => m.public_url) },
      }));
      publishId = init.publish_id;
    }

    // 2) Poll status until PUBLISH_COMPLETE / FAILED. From here on TikTok owns the post: a status
    //    fetch hiccup must not make the scheduler re-run init (that would post a duplicate).
    const status = await pollPublishStatus(publishId, () => poll(
      async () => {
        const { data: s, raw } = await tiktokApiRaw<{ status: string; fail_reason?: string }>(
          "/v2/post/publish/status/fetch/",
          token,
          { publish_id: publishId },
        );
        if (s.status === "PUBLISH_COMPLETE") {
          // Post ids are int64 and exceed Number precision, so read them from the raw JSON text.
          // (Field name is spelled "publicaly" in TikTok's API.)
          const m = /"publicaly_available_post_id"\s*:\s*\[\s*"?(\d+)/.exec(raw);
          return { postId: m?.[1] };
        }
        if (s.status === "FAILED") {
          // "internal" is the only fail_reason TikTok marks as retryable.
          throw new TikTokPublishFailed(`TikTok: publish failed (${s.fail_reason ?? "unknown"})`, s.fail_reason === "internal");
        }
        return undefined; // PROCESSING_UPLOAD / PROCESSING_DOWNLOAD / SEND_TO_USER_INBOX
      },
      { intervalMs: 5000, timeoutMs: 5 * 60_000 },
    ));
    if (!status) {
      // Don't retry: the post may still go live and a retry would duplicate it.
      throw new PublishError(`TikTok: still processing after 5 minutes (publish_id ${publishId}); check the TikTok app.`, false);
    }

    // SELF_ONLY / private posts may have no public id.
    const postId = status.postId;
    if (!postId) return { platform_post_id: publishId, platform_post_url: null };
    const user = info.creator_username;
    const kind = video ? "video" : "photo";
    return {
      platform_post_id: postId,
      platform_post_url: user ? `https://www.tiktok.com/@${user}/${kind}/${postId}` : null,
    };
  },
};
