import type { Platform, Provider } from "@/lib/types";

// UI-only platform metadata. Colours are simple brand-ish hues for a dot/letter badge;
// we deliberately do not reproduce any brand logos.

export interface PlatformUi {
  label: string;
  short: string; // 1–2 letter badge text
  color: string; // hex, used via inline style
  maxText: number;
}

export const PLATFORM_UI: Record<Platform, PlatformUi> = {
  facebook: { label: "Facebook", short: "F", color: "#1877f2", maxText: 63206 },
  instagram: { label: "Instagram", short: "IG", color: "#d6249f", maxText: 2200 },
  linkedin: { label: "LinkedIn", short: "in", color: "#0a66c2", maxText: 3000 },
  youtube: { label: "YouTube", short: "YT", color: "#e62117", maxText: 5000 },
  tiktok: { label: "TikTok", short: "TT", color: "#111827", maxText: 2200 },
};

export const YOUTUBE_TITLE_MAX = 100;

export const PROVIDER_UI: Record<Provider, { label: string; blurb: string }> = {
  meta: { label: "Meta", blurb: "Facebook Pages and their linked Instagram business accounts." },
  linkedin: { label: "LinkedIn", blurb: "Your LinkedIn profile (and company pages if granted)." },
  google: { label: "Google", blurb: "Your YouTube channel." },
  tiktok: { label: "TikTok", blurb: "Your TikTok creator account." },
};
