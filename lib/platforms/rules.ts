import type { Platform, PublishContent, TargetOptions } from "../types";
import type { PlatformRules } from "./types";

// Per-platform publishing limits. Pure data + pure validation (no network), shared by the
// composer (via POST /api/posts validation) and by publishers right before publishing.

export const PLATFORM_RULES: Record<Platform, PlatformRules> = {
  facebook: {
    platform: "facebook",
    label: "Facebook Page",
    maxTextLength: 63206,
    requiresMedia: false,
    requiresVideo: false,
    allowsImages: true,
    allowsVideo: true,
    // Multi-photo feed posts via attached_media. VERIFY: Meta doesn't document a hard cap; 10 is a safe limit.
    maxMediaCount: 10,
    requiredOptions: [],
  },
  instagram: {
    platform: "instagram",
    label: "Instagram",
    maxTextLength: 2200,
    requiresMedia: true,
    requiresVideo: false,
    allowsImages: true,
    allowsVideo: true,
    // Contract says carousel up to 10. Meta's content-publishing docs (checked 2026-11) now allow up
    // to 20 carousel children; raise this to 20 if you want the newer limit.
    maxMediaCount: 10,
    requiredOptions: [],
  },
  linkedin: {
    platform: "linkedin",
    label: "LinkedIn",
    maxTextLength: 3000,
    requiresMedia: false,
    requiresVideo: false,
    allowsImages: true,
    allowsVideo: true,
    // MultiImage API: 2–20 images (verified on learn.microsoft.com, 2026-11).
    maxMediaCount: 20,
    requiredOptions: [],
  },
  youtube: {
    platform: "youtube",
    label: "YouTube",
    maxTextLength: 5000, // description
    requiresMedia: true,
    requiresVideo: true,
    allowsImages: false,
    allowsVideo: true,
    maxMediaCount: 1,
    requiredOptions: ["title"],
  },
  tiktok: {
    platform: "tiktok",
    label: "TikTok",
    maxTextLength: 2200, // video title; photo description allows 4000 but we keep one limit
    requiresMedia: true,
    requiresVideo: false,
    allowsImages: true,
    allowsVideo: true,
    // Photo posts: up to 35 images (verified on developers.tiktok.com, 2026-11). Video: exactly 1.
    maxMediaCount: 35,
    requiredOptions: [],
  },
};

const YT_PRIVACY = new Set<TargetOptions["privacy"]>(["public", "private", "unlisted"]);
const TIKTOK_PRIVACY = new Set<TargetOptions["privacy"]>(["public", "friends", "self_only", "private"]);

/** UTF-16 length is what most platforms count; good enough for limits. */
function len(s: string): number {
  return s.length;
}

export function validateContent(platform: Platform, c: PublishContent): string[] {
  const rules = PLATFORM_RULES[platform];
  if (!rules) return [`Unknown platform: ${platform}`];
  const L = rules.label;
  const errs: string[] = [];
  const text = c.text ?? "";
  const media = c.media ?? [];
  const opts = c.options ?? {};
  const images = media.filter((m) => m.kind === "image");
  const videos = media.filter((m) => m.kind === "video");

  if (len(text) > rules.maxTextLength) {
    errs.push(`${L}: text is ${len(text)} characters; the limit is ${rules.maxTextLength}.`);
  }
  if (rules.requiresMedia && media.length === 0) {
    errs.push(rules.requiresVideo ? `${L} requires a video.` : `${L} requires at least one image or video.`);
  }
  if (!rules.allowsImages && images.length > 0) errs.push(`${L} doesn't accept images.`);
  if (!rules.allowsVideo && videos.length > 0) errs.push(`${L} doesn't accept videos.`);
  if (media.length > rules.maxMediaCount) {
    errs.push(`${L} allows at most ${rules.maxMediaCount} media items (got ${media.length}).`);
  }
  for (const key of rules.requiredOptions) {
    const v = opts[key];
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
      errs.push(`${L} requires a ${key}.`);
    }
  }

  switch (platform) {
    case "facebook": {
      if (videos.length > 0 && (videos.length > 1 || images.length > 0)) {
        errs.push("Facebook: a video post must contain exactly one video and no images.");
      }
      if (opts.link) {
        if (!isHttpUrl(opts.link)) errs.push("Facebook: link must be an http(s) URL.");
        if (media.length > 0) errs.push("Facebook: a link can't be combined with images or video.");
      }
      if (!text.trim() && media.length === 0 && !opts.link) errs.push("Facebook: post needs text, a link or media.");
      break;
    }
    case "instagram": {
      const type = opts.ig_type ?? "feed";
      // Instagram's content publishing API only supports JPEG images.
      if (images.some((m) => m.mime_type !== "image/jpeg")) errs.push("Instagram only accepts JPEG images.");
      if (type === "story" && media.length > 1) errs.push("Instagram stories take exactly one image or video.");
      if (type === "reel" && (videos.length !== 1 || images.length > 0)) errs.push("Instagram reels need exactly one video.");
      // Feed: single image, single video (published as a Reel), or carousel (2–10, images and videos may be mixed).
      break;
    }
    case "linkedin": {
      if (videos.length > 1) errs.push("LinkedIn: only one video per post.");
      if (videos.length > 0 && images.length > 0) errs.push("LinkedIn: can't mix images and video in one post.");
      if (!text.trim() && media.length === 0) errs.push("LinkedIn: post needs text or media.");
      if (images.some((m) => !["image/jpeg", "image/png", "image/gif"].includes(m.mime_type))) {
        errs.push("LinkedIn accepts JPEG, PNG or GIF images.");
      }
      break;
    }
    case "youtube": {
      if (videos.length !== 1) errs.push("YouTube requires exactly one video.");
      const title = (opts.title ?? "").trim();
      if (title.length > 100) errs.push(`YouTube: title is ${title.length} characters; the limit is 100.`);
      if (/[<>]/.test(title)) errs.push("YouTube: title can't contain < or >.");
      if (/[<>]/.test(text)) errs.push("YouTube: description can't contain < or >.");
      if (opts.privacy && !YT_PRIVACY.has(opts.privacy)) errs.push("YouTube privacy must be public, private or unlisted.");
      break;
    }
    case "tiktok": {
      if (videos.length > 0 && (videos.length > 1 || images.length > 0)) {
        errs.push("TikTok: post either exactly one video or 1–35 images, not both.");
      }
      if (images.length > 0 && videos.length === 0) {
        if (images.some((m) => !["image/jpeg", "image/webp"].includes(m.mime_type))) {
          errs.push("TikTok photo posts accept JPEG or WebP images only.");
        }
        if (opts.title && len(opts.title) > 90) errs.push("TikTok: photo title limit is 90 characters.");
      }
      if (opts.privacy && !TIKTOK_PRIVACY.has(opts.privacy)) errs.push("TikTok privacy must be public, friends or self_only.");
      break;
    }
  }
  return errs;
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
