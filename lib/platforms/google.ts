import fs from "node:fs";
import { Readable } from "node:stream";
import { config } from "../config";
import { PublishError, type AccountWithTokens, type PublishContent, type PublishResult } from "../types";
import type { ConnectedAccount, PlatformPublisher, ProviderAdapter, TokenRefreshResult } from "./types";
import { PLATFORM_RULES, validateContent } from "./rules";
import { expiresAtFromSeconds, form, http, httpJson } from "./http";

// Google OAuth 2.0 (web server flow + PKCE S256) -> YouTube channels.
// access_type=offline + prompt=consent so Google always returns a refresh_token.
//
// NOTE: videos uploaded via an *unverified* API project (created after 2020-07-28) are locked to
// private until the project passes Google's API compliance audit, regardless of privacyStatus.

const SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"];
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const label = "YouTube";

interface GoogleToken {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

async function tokenRequest(params: Record<string, string | undefined>): Promise<GoogleToken> {
  const { data } = await httpJson<GoogleToken>(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ ...params, client_id: config.google.clientId, client_secret: config.google.clientSecret }),
    label: "Google",
  });
  return data;
}

export const googleProvider: ProviderAdapter = {
  provider: "google",
  label: "Google (YouTube)",
  usesPkce: true,
  getAuthUrl({ state, redirectUri, codeChallenge }) {
    const p = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    if (codeChallenge) {
      p.set("code_challenge", codeChallenge);
      p.set("code_challenge_method", "S256");
    }
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  },
  async exchangeCode({ code, redirectUri, codeVerifier }) {
    const tok = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier });
    const { data } = await httpJson<{
      items?: { id: string; snippet?: { title?: string; customUrl?: string; thumbnails?: { default?: { url?: string } } } }[];
    }>("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=50", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
      label,
    });
    const items = data.items ?? [];
    if (items.length === 0) throw new Error("This Google account has no YouTube channel. Create one at youtube.com first.");
    const expires = expiresAtFromSeconds(tok.expires_in);
    return items.map<ConnectedAccount>((ch) => ({
      platform: "youtube",
      platform_account_id: ch.id,
      display_name: ch.snippet?.title || ch.id,
      avatar_url: ch.snippet?.thumbnails?.default?.url ?? null,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? null,
      token_expires_at: expires,
      scopes: tok.scope ?? SCOPES.join(" "),
      meta: { custom_url: ch.snippet?.customUrl ?? null },
    }));
  },
  async refresh(account: AccountWithTokens): Promise<TokenRefreshResult> {
    if (!account.refresh_token) throw new PublishError("Google: no refresh token; reconnect the account", false, true);
    const tok = await tokenRequest({ grant_type: "refresh_token", refresh_token: account.refresh_token });
    return {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? null, // Google usually doesn't rotate; keep existing.
      token_expires_at: expiresAtFromSeconds(tok.expires_in),
    };
  },
};

function privacyStatus(p: PublishContent["options"]["privacy"]): "public" | "private" | "unlisted" {
  return p === "public" || p === "unlisted" ? p : "private";
}

/**
 * Query a resumable upload session's status (`PUT` with `Content-Range: bytes * /<size>`, no body).
 * 200/201 => upload complete, returns the video id; 308 => incomplete; anything else => unknown.
 */
async function completedUploadId(uploadUrl: string, token: string, size: number): Promise<string | null> {
  try {
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Length": "0", "Content-Range": `bytes */${size}` },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status !== 200 && res.status !== 201) return null;
    const v = (await res.json().catch(() => null)) as { id?: string } | null;
    return v?.id ?? null;
  } catch {
    return null;
  }
}

export const youtubePublisher: PlatformPublisher = {
  platform: "youtube",
  rules: PLATFORM_RULES.youtube,
  validate: (c) => validateContent("youtube", c),
  async publish(account: AccountWithTokens, c: PublishContent): Promise<PublishResult> {
    const problems = validateContent("youtube", c);
    if (problems.length) throw new PublishError(problems.join(" "), false);
    const video = c.media.find((m) => m.kind === "video")!;
    const size = (await fs.promises.stat(video.path)).size;

    // 1) Start a resumable session; the upload URL comes back in the Location header.
    const init = await http(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${account.access_token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(size),
          "X-Upload-Content-Type": video.mime_type,
        },
        body: JSON.stringify({
          snippet: {
            title: (c.options.title ?? "").trim(),
            description: c.text ?? "",
            categoryId: "22", // People & Blogs
          },
          status: { privacyStatus: privacyStatus(c.options.privacy), selfDeclaredMadeForKids: false },
        }),
        label,
      },
    );
    const uploadUrl = init.headers.get("location");
    if (!uploadUrl) throw new PublishError("YouTube: no resumable upload URL returned", true);

    // 2) Stream the file from disk in one PUT. (For very large files / flaky networks, resume by
    //    querying the session with `Content-Range: bytes */<size>`; a retry here restarts the upload.)
    const body = Readable.toWeb(fs.createReadStream(video.path)) as unknown as ReadableStream<Uint8Array>;
    let data: { id?: string };
    try {
      ({ data } = await httpJson<{ id: string }>(uploadUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${account.access_token}`,
          "Content-Type": video.mime_type,
          "Content-Length": String(size),
        },
        body,
        // Node's fetch requires duplex for streaming request bodies.
        ...({ duplex: "half" } as Record<string, unknown>),
        label,
        timeoutMs: 60 * 60_000,
      }));
    } catch (err) {
      // The upload may have completed even though we lost the response (timeout / reset / 5xx).
      // Ask the resumable session before letting the scheduler retry, or a retry would upload a
      // duplicate video.
      if (!(err instanceof PublishError) || !err.retryable) throw err;
      const id = await completedUploadId(uploadUrl, account.access_token, size);
      if (!id) throw err;
      data = { id };
    }
    if (!data?.id) throw new PublishError("YouTube: upload finished without a video id", false);
    return { platform_post_id: data.id, platform_post_url: `https://www.youtube.com/watch?v=${data.id}` };
  },
};
