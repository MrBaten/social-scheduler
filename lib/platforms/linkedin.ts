import fs from "node:fs";
import { config } from "../config";
import { PublishError, type AccountWithTokens, type MediaItem, type PublishContent, type PublishResult } from "../types";
import type { ConnectedAccount, PlatformPublisher, ProviderAdapter, TokenRefreshResult } from "./types";
import { PLATFORM_RULES, validateContent } from "./rules";
import { expiresAtFromSeconds, form, http, httpJson, noRetryIfUncertain, poll } from "./http";

// LinkedIn: OAuth 2.0 authorization code (3-legged, no PKCE), "Sign In with LinkedIn using
// OpenID Connect" + "Share on LinkedIn" products -> scopes openid profile email w_member_social.
// Posting uses the versioned Posts API (/rest/posts) with media uploaded via Images/Videos APIs.
//
// Organization (Company Page) posting needs w_organization_social + r_organization_social, which
// are only granted to apps approved for the Community Management API. Requesting them without
// approval makes the auth dialog fail, so they're opt-in via LINKEDIN_ORG_POSTING=true.
//
// Access tokens last ~60 days. Refresh tokens are only issued to approved partners
// (programmatic refresh); if none is returned the user simply reconnects after expiry.

const BASE_SCOPES = ["openid", "profile", "email", "w_member_social"];
// rw_organization_admin: GET /rest/organizationAcls (listing the Pages the member administers) needs an
// organization-admin permission (learn.microsoft.com "Organization Access Control by Role", 2026-11);
// without it the org listing 403s and only the member account connects. All three ship with the
// Community Management API product.
const ORG_SCOPES = ["w_organization_social", "r_organization_social", "rw_organization_admin"];
const orgPostingEnabled = () => process.env.LINKEDIN_ORG_POSTING === "true";
const scopes = () => (orgPostingEnabled() ? [...BASE_SCOPES, ...ORG_SCOPES] : BASE_SCOPES);

const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const API = "https://api.linkedin.com";
const label = "LinkedIn";

function restHeaders(token: string, json = true): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Linkedin-Version": config.linkedin.apiVersion,
    "X-Restli-Protocol-Version": "2.0.0",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const { data } = await httpJson<TokenResponse>(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ ...params, client_id: config.linkedin.clientId, client_secret: config.linkedin.clientSecret }),
    label,
  });
  return data;
}

export const linkedinProvider: ProviderAdapter = {
  provider: "linkedin",
  label: "LinkedIn",
  usesPkce: false,
  getAuthUrl({ state, redirectUri }) {
    const p = new URLSearchParams({
      response_type: "code",
      client_id: config.linkedin.clientId,
      redirect_uri: redirectUri,
      state,
      scope: scopes().join(" "),
    });
    return `https://www.linkedin.com/oauth/v2/authorization?${p}`;
  },
  async exchangeCode({ code, redirectUri }) {
    const tok = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    const expires = expiresAtFromSeconds(tok.expires_in);
    const granted = tok.scope ?? scopes().join(",");

    const { data: me } = await httpJson<{ sub: string; name?: string; picture?: string; email?: string }>(`${API}/v2/userinfo`, {
      headers: { Authorization: `Bearer ${tok.access_token}` },
      label,
    });
    const base = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? null,
      token_expires_at: expires,
      scopes: granted,
    };
    const out: ConnectedAccount[] = [
      {
        ...base,
        platform: "linkedin",
        platform_account_id: `urn:li:person:${me.sub}`,
        display_name: me.name || me.email || "LinkedIn member",
        avatar_url: me.picture ?? null,
        meta: { kind: "person", email: me.email ?? null },
      },
    ];

    if (/w_organization_social/.test(granted)) {
      try {
        out.push(...(await listAdminOrganizations(tok.access_token, base)));
      } catch (err) {
        // Org listing is best-effort; the member account still connects.
        console.warn("[linkedin] could not list organizations:", (err as Error).message);
      }
    }
    return out;
  },
  async refresh(account: AccountWithTokens): Promise<TokenRefreshResult> {
    if (!account.refresh_token) throw new PublishError("LinkedIn: no refresh token; reconnect the account", false, true);
    const tok = await tokenRequest({ grant_type: "refresh_token", refresh_token: account.refresh_token });
    return {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? null,
      token_expires_at: expiresAtFromSeconds(tok.expires_in),
    };
  },
};

/** Pages the member administers (needs rw_organization_admin, see ORG_SCOPES). */
async function listAdminOrganizations(
  token: string,
  base: Pick<ConnectedAccount, "access_token" | "refresh_token" | "token_expires_at" | "scopes">,
): Promise<ConnectedAccount[]> {
  const { data } = await httpJson<{ elements?: { organization?: string; organizationTarget?: string }[] }>(
    `${API}/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`,
    { headers: restHeaders(token, false), label },
  );
  const out: ConnectedAccount[] = [];
  for (const el of data.elements ?? []) {
    const urn = el.organization ?? el.organizationTarget;
    if (!urn) continue;
    const id = urn.split(":").pop()!;
    let name = `Organization ${id}`;
    try {
      const { data: org } = await httpJson<{ localizedName?: string }>(`${API}/rest/organizations/${id}`, {
        headers: restHeaders(token, false),
        label,
      });
      if (org.localizedName) name = org.localizedName;
    } catch {
      /* keep fallback name */
    }
    out.push({ ...base, platform: "linkedin", platform_account_id: urn, display_name: name, avatar_url: null, meta: { kind: "organization" } });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------------------------

/**
 * Posts API `commentary` uses "little text format": reserved characters must be backslash-escaped
 * or the text gets truncated/rejected. We keep plain #hashtags working by not escaping `#` when it
 * starts a word: the little-text grammar defines `HashtagElement ::= '#' SINGLE_WORD` (checked 2026-11).
 */
export function escapeLittleText(s: string): string {
  return s.replace(/[\\|{}@\[\]()<>*_~#]/g, (ch, idx: number, str: string) => {
    if (ch === "#" && /[\p{L}\p{N}_]/u.test(str[idx + 1] ?? "")) return ch;
    return `\\${ch}`;
  });
}

function authorUrn(account: AccountWithTokens): string {
  const id = account.platform_account_id;
  return id.startsWith("urn:li:") ? id : `urn:li:person:${id}`;
}

async function uploadImage(token: string, owner: string, m: MediaItem): Promise<string> {
  const { data } = await httpJson<{ value: { uploadUrl: string; image: string } }>(`${API}/rest/images?action=initializeUpload`, {
    method: "POST",
    headers: restHeaders(token),
    body: JSON.stringify({ initializeUploadRequest: { owner } }),
    label,
  });
  const bytes = await fs.promises.readFile(m.path);
  await http(data.value.uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": m.mime_type },
    body: bytes,
    label,
    timeoutMs: 120_000,
  });
  return data.value.image;
}

async function uploadVideo(token: string, owner: string, m: MediaItem): Promise<string> {
  const size = (await fs.promises.stat(m.path)).size;
  const { data } = await httpJson<{
    value: { video: string; uploadToken: string; uploadInstructions: { uploadUrl: string; firstByte: number; lastByte: number }[] };
  }>(`${API}/rest/videos?action=initializeUpload`, {
    method: "POST",
    headers: restHeaders(token),
    body: JSON.stringify({ initializeUploadRequest: { owner, fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: false } }),
    label,
  });
  const { video, uploadToken, uploadInstructions } = data.value;

  // Upload each byte range (inclusive) in order and collect ETags for finalizeUpload.
  const etags: string[] = [];
  const fh = await fs.promises.open(m.path, "r");
  try {
    for (const part of uploadInstructions) {
      const length = part.lastByte - part.firstByte + 1;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, part.firstByte);
      const res = await http(part.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: buf,
        label,
        timeoutMs: 300_000,
      });
      const etag = res.headers.get("etag");
      if (!etag) throw new PublishError("LinkedIn: video part upload returned no ETag", true);
      etags.push(etag);
    }
  } finally {
    await fh.close();
  }

  await http(`${API}/rest/videos?action=finalizeUpload`, {
    method: "POST",
    headers: restHeaders(token),
    body: JSON.stringify({ finalizeUploadRequest: { video, uploadToken, uploadedPartIds: etags } }),
    label,
  });

  // Wait until processing finishes. VERIFY: LinkedIn may accept a post referencing a video that's
  // still PROCESSING; we wait up to 5 min then try anyway.
  await poll(
    async () => {
      const { data: v } = await httpJson<{ status?: string }>(`${API}/rest/videos/${encodeURIComponent(video)}`, {
        headers: restHeaders(token, false),
        label,
      });
      if (v.status === "AVAILABLE") return true;
      if (v.status === "PROCESSING_FAILED") throw new PublishError("LinkedIn: video processing failed", false);
      return undefined;
    },
    { intervalMs: 5000, timeoutMs: 5 * 60_000 },
  );
  return video;
}

export const linkedinPublisher: PlatformPublisher = {
  platform: "linkedin",
  rules: PLATFORM_RULES.linkedin,
  validate: (c) => validateContent("linkedin", c),
  async publish(account: AccountWithTokens, c: PublishContent): Promise<PublishResult> {
    const problems = validateContent("linkedin", c);
    if (problems.length) throw new PublishError(problems.join(" "), false);
    const token = account.access_token;
    const author = authorUrn(account);
    const images = c.media.filter((m) => m.kind === "image");
    const video = c.media.find((m) => m.kind === "video");

    let content: Record<string, unknown> | undefined;
    if (video) {
      const urn = await uploadVideo(token, author, video);
      content = { media: { id: urn, ...(c.options.title ? { title: c.options.title } : {}) } };
    } else if (images.length === 1) {
      content = { media: { id: await uploadImage(token, author, images[0]) } };
    } else if (images.length > 1) {
      const ids: string[] = [];
      for (const m of images) ids.push(await uploadImage(token, author, m));
      content = { multiImage: { images: ids.map((id) => ({ id })) } };
    }

    const body = {
      author,
      commentary: escapeLittleText(c.text ?? ""),
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
      ...(content ? { content } : {}),
    };
    const res = await noRetryIfUncertain(label, () =>
      http(`${API}/rest/posts`, { method: "POST", headers: restHeaders(token), body: JSON.stringify(body), label }),
    );
    const urn = res.headers.get("x-restli-id");
    if (!urn) throw new PublishError("LinkedIn: post created but no id returned", false);
    return { platform_post_id: urn, platform_post_url: `https://www.linkedin.com/feed/update/${urn}` };
  },
};
