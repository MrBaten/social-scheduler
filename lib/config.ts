import type { Provider } from "./types";

// Central env access. The OPERATOR (you) registers ONE developer app per provider and puts
// its keys here. End users never see keys: they just click "Connect" and log in via OAuth.

export const config = {
  appUrl: (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, ""),
  /** Base URL platforms can fetch media from. Instagram & TikTok download media by URL, so
   *  in production this must be public (e.g. Supabase Storage / S3 / ngrok in dev). */
  publicMediaBaseUrl: (process.env.PUBLIC_MEDIA_BASE_URL || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, ""),
  /** Force demo mode for every provider even if keys exist. */
  forceDemo: process.env.DEMO_MODE === "true",
  cronSecret: process.env.CRON_SECRET || "",
  /** SIGNUP_ENABLED=false closes sign-up (existing users can still log in). */
  signupEnabled: process.env.SIGNUP_ENABLED !== "false",
  /** Optional comma-separated allowlist. When set, only these emails can sign up or log in. */
  allowedEmails: (process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 200) * 1024 * 1024,
  meta: {
    appId: process.env.META_APP_ID || "",
    appSecret: process.env.META_APP_SECRET || "",
    graphVersion: process.env.META_GRAPH_VERSION || "v25.0",
    /** Facebook Login for Business configuration ID. When set, the login dialog sends
     *  config_id instead of a scope list (Business-type apps require this). Create it in
     *  App Dashboard -> Facebook Login for Business -> Configurations, token type "User access token". */
    loginConfigId: process.env.META_LOGIN_CONFIG_ID || "",
  },
  linkedin: {
    clientId: process.env.LINKEDIN_CLIENT_ID || "",
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET || "",
    // YYYYMM, sent as Linkedin-Version header. Each version lives ~12 months: 202510 was sunset
    // 2026-10-15 (learn.microsoft.com migrations table, checked 2026-11); 202610 is active until 2027-10-15.
    apiVersion: process.env.LINKEDIN_API_VERSION || "202610",
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  },
  tiktok: {
    clientKey: process.env.TIKTOK_CLIENT_KEY || "",
    clientSecret: process.env.TIKTOK_CLIENT_SECRET || "",
  },
};

export function providerHasKeys(p: Provider): boolean {
  switch (p) {
    case "meta":
      return !!(config.meta.appId && config.meta.appSecret);
    case "linkedin":
      return !!(config.linkedin.clientId && config.linkedin.clientSecret);
    case "google":
      return !!(config.google.clientId && config.google.clientSecret);
    case "tiktok":
      return !!(config.tiktok.clientKey && config.tiktok.clientSecret);
  }
}

/** True when connecting this provider should create simulated demo accounts. */
export function isDemoProvider(p: Provider): boolean {
  return config.forceDemo || !providerHasKeys(p);
}

export function oauthRedirectUri(p: Provider): string {
  return `${config.appUrl}/api/oauth/${p}/callback`;
}
