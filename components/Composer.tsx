"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { CreatePostInput, Platform, PostWithTargets, SocialAccountPublic, TargetOptions } from "@/lib/types";
import { PLATFORMS } from "@/lib/types";
import { api, ApiError, extractTargetErrors } from "./api";
import { Button, buttonClasses, Spinner } from "./Button";
import { Alert, Card, DemoBadge } from "./Card";
import { PlatformBadge, PlatformIcon } from "./PlatformBadge";
import { PLATFORM_UI, YOUTUBE_TITLE_MAX } from "./platforms";

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime";

interface UploadedMedia {
  /** Local key (stable across upload -> done). */
  key: string;
  id: string | null; // server media id once uploaded
  public_url: string | null;
  mime_type: string;
  filename: string;
  size_bytes: number;
  previewUrl: string | null; // object URL for instant preview
  status: "uploading" | "done" | "error";
  error?: string;
}

interface TargetDraft {
  open: boolean;
  customText: boolean;
  text: string;
  options: TargetOptions;
}

interface Hint {
  level: "error" | "warn";
  msg: string;
}

function defaultOptions(p: Platform): TargetOptions {
  switch (p) {
    case "youtube":
      return { title: "", privacy: "public" };
    case "tiktok":
      // Unaudited TikTok apps may only post with SELF_ONLY visibility.
      return { privacy: "self_only" };
    case "instagram":
      return { ig_type: "feed" };
    case "facebook":
      return { link: "" };
    default:
      return {};
  }
}

/** Only send options relevant to the platform; drop empty strings. */
function cleanOptions(p: Platform, o: TargetOptions): TargetOptions | undefined {
  const out: TargetOptions = {};
  if (p === "youtube") {
    out.title = (o.title ?? "").trim();
    out.privacy = o.privacy ?? "public";
  } else if (p === "tiktok") {
    out.privacy = o.privacy ?? "self_only";
  } else if (p === "instagram") {
    out.ig_type = o.ig_type ?? "feed";
  } else if (p === "facebook") {
    const link = (o.link ?? "").trim();
    if (link) out.link = link;
  }
  return Object.keys(out).length ? out : undefined;
}

function hintsFor(p: Platform, text: string, opts: TargetOptions, media: UploadedMedia[]): Hint[] {
  const hints: Hint[] = [];
  const ready = media.filter((m) => m.status !== "error");
  const videos = ready.filter((m) => m.mime_type.startsWith("video/")).length;
  const images = ready.filter((m) => m.mime_type.startsWith("image/")).length;
  const limit = PLATFORM_UI[p].maxText;
  if (text.length > limit) hints.push({ level: "error", msg: `Text is ${text.length - limit} characters over the ${limit.toLocaleString()} limit.` });

  switch (p) {
    case "youtube": {
      const title = (opts.title ?? "").trim();
      if (!title) hints.push({ level: "error", msg: "YouTube needs a title." });
      if (title.length > YOUTUBE_TITLE_MAX) hints.push({ level: "error", msg: `Title is over ${YOUTUBE_TITLE_MAX} characters.` });
      if (videos === 0) hints.push({ level: "error", msg: "YouTube needs a video." });
      if (videos > 1 || images > 0) hints.push({ level: "warn", msg: "YouTube takes exactly one video; extra media may be rejected." });
      break;
    }
    case "tiktok":
      if (ready.length === 0) hints.push({ level: "error", msg: "TikTok needs a video (or photos)." });
      if (videos > 0 && images > 0) hints.push({ level: "error", msg: "TikTok can't mix photos and video in one post." });
      if (videos > 1) hints.push({ level: "error", msg: "TikTok takes a single video." });
      break;
    case "instagram":
      if (ready.length === 0) hints.push({ level: "error", msg: "Instagram needs at least one image or video." });
      if (opts.ig_type === "reel" && videos === 0) hints.push({ level: "error", msg: "Reels need a video." });
      if (opts.ig_type === "reel" && ready.length > 1) hints.push({ level: "warn", msg: "Reels use a single video." });
      if (opts.ig_type === "story" && ready.length > 1) hints.push({ level: "warn", msg: "Stories use a single image or video." });
      if ((opts.ig_type ?? "feed") === "feed" && ready.length > 10) hints.push({ level: "error", msg: "Carousels allow at most 10 items." });
      break;
    case "facebook": {
      const link = (opts.link ?? "").trim();
      if (link && !/^https?:\/\/\S+$/i.test(link)) hints.push({ level: "warn", msg: "Link should start with http:// or https://" });
      break;
    }
    default:
      break;
  }
  return hints;
}

function Counter({ value, max, label }: { value: number; max: number; label?: string }) {
  const over = value > max;
  const near = !over && value > max * 0.9;
  return (
    <span
      className={`tabular-nums text-xs font-medium ${over ? "text-red-600" : near ? "text-amber-600" : "text-gray-500"}`}
      aria-live="polite"
    >
      {label ? `${label} ` : ""}
      {value.toLocaleString()}/{max.toLocaleString()}
    </span>
  );
}

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fieldClass =
  "block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm " +
  "placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20";

export function Composer() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<SocialAccountPublic[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [baseText, setBaseText] = useState("");
  const [media, setMedia] = useState<UploadedMedia[]>([]);
  const [targets, setTargets] = useState<Record<string, TargetDraft>>({});

  const [when, setWhen] = useState<"now" | "schedule">("now");
  const [scheduleLocal, setScheduleLocal] = useState("");
  const [timeZone, setTimeZone] = useState<string>("");
  const [minLocal, setMinLocal] = useState<string>("");

  const [submitting, setSubmitting] = useState<null | "publish" | "draft">(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const mediaRef = useRef<UploadedMedia[]>([]);
  useEffect(() => {
    mediaRef.current = media;
  }, [media]);

  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    setMinLocal(toLocalInputValue(new Date()));
    api<{ accounts: SocialAccountPublic[] }>("/api/accounts")
      .then((r) => setAccounts(r.accounts ?? []))
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : "Could not load accounts"));
    return () => {
      for (const m of mediaRef.current) if (m.previewUrl) URL.revokeObjectURL(m.previewUrl);
    };
  }, []);

  const accountById = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a])), [accounts]);
  const grouped = useMemo(
    () =>
      PLATFORMS.map((p) => ({ platform: p, accounts: (accounts ?? []).filter((a) => a.platform === p) })).filter(
        (g) => g.accounts.length > 0,
      ),
    [accounts],
  );
  const selectedIds = useMemo(
    () => (accounts ?? []).filter((a) => targets[a.id]).map((a) => a.id),
    [accounts, targets],
  );

  // ---------- media ----------
  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    const items: UploadedMedia[] = list.map((f) => ({
      key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      id: null,
      public_url: null,
      mime_type: f.type || "application/octet-stream",
      filename: f.name,
      size_bytes: f.size,
      previewUrl: f.type.startsWith("image/") || f.type.startsWith("video/") ? URL.createObjectURL(f) : null,
      status: "uploading",
    }));
    setMedia((prev) => [...prev, ...items]);

    // Upload sequentially to keep ordering predictable and avoid hammering the server.
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      const key = items[i].key;
      try {
        const fd = new FormData();
        fd.append("file", file);
        const r = await api<{ media: { id: string; public_url: string; mime_type: string; filename: string; size_bytes: number } }>(
          "/api/media",
          { method: "POST", body: fd },
        );
        setMedia((prev) =>
          prev.map((m) =>
            m.key === key
              ? { ...m, id: r.media.id, public_url: r.media.public_url, mime_type: r.media.mime_type || m.mime_type, status: "done" }
              : m,
          ),
        );
      } catch (e) {
        setMedia((prev) =>
          prev.map((m) => (m.key === key ? { ...m, status: "error", error: e instanceof Error ? e.message : "Upload failed" } : m)),
        );
      }
    }
  }, []);

  function removeMedia(key: string) {
    setMedia((prev) => {
      const m = prev.find((x) => x.key === key);
      if (m?.previewUrl) URL.revokeObjectURL(m.previewUrl);
      return prev.filter((x) => x.key !== key);
    });
  }

  function moveMedia(key: string, dir: -1 | 1) {
    setMedia((prev) => {
      const i = prev.findIndex((x) => x.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length) void uploadFiles(e.dataTransfer.files);
  }

  // ---------- targets ----------
  function toggleAccount(a: SocialAccountPublic, on: boolean) {
    setTargets((prev) => {
      const next = { ...prev };
      if (on) next[a.id] = prev[a.id] ?? { open: false, customText: false, text: "", options: defaultOptions(a.platform) };
      else delete next[a.id];
      return next;
    });
  }

  function togglePlatform(p: Platform, on: boolean) {
    for (const a of (accounts ?? []).filter((x) => x.platform === p && x.status === "active")) toggleAccount(a, on);
  }

  function updateTarget(id: string, patch: Partial<TargetDraft>) {
    setTargets((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev));
  }

  function updateOptions(id: string, patch: Partial<TargetOptions>) {
    setTargets((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], options: { ...prev[id].options, ...patch } } } : prev));
  }

  const effectiveText = (id: string) => {
    const t = targets[id];
    return t?.customText ? t.text : baseText;
  };

  // ---------- submit ----------
  async function submit(kind: "publish" | "draft") {
    setErrors({});
    setFormError(null);

    if (kind === "publish" && selectedIds.length === 0) return setFormError("Select at least one account to post to.");
    if (media.some((m) => m.status === "uploading")) return setFormError("Please wait for uploads to finish.");
    const hasAnyText = baseText.trim() || selectedIds.some((id) => targets[id]?.customText && targets[id].text.trim());
    const readyMedia = media.filter((m) => m.status === "done" && m.id);
    if (!hasAnyText && readyMedia.length === 0) return setFormError("Write something or add media first.");

    let scheduled_at: string | null = null;
    if (kind === "publish") {
      if (when === "now") {
        scheduled_at = new Date().toISOString();
      } else {
        if (!scheduleLocal) return setFormError("Pick a date and time to schedule.");
        // datetime-local has no zone; `new Date("YYYY-MM-DDTHH:mm")` parses it as browser local time.
        const d = new Date(scheduleLocal);
        if (Number.isNaN(d.getTime())) return setFormError("That date/time is not valid.");
        if (d.getTime() < Date.now() - 60_000) return setFormError("The scheduled time is in the past.");
        scheduled_at = d.toISOString();
      }
    }

    const input: CreatePostInput = {
      base_text: baseText,
      media_ids: readyMedia.map((m) => m.id as string),
      scheduled_at,
      targets: selectedIds.map((id) => {
        const a = accountById.get(id)!;
        const t = targets[id];
        return {
          social_account_id: id,
          text_override: t.customText ? t.text : null,
          options: cleanOptions(a.platform, t.options),
        };
      }),
    };

    setSubmitting(kind);
    try {
      const r = await api<{ post: PostWithTargets }>("/api/posts", { method: "POST", json: input });
      const post = r.post;
      if (kind === "publish" && when === "now") {
        try {
          await api(`/api/posts/${post.id}/publish-now`, { method: "POST" });
        } catch {
          // The post exists; its detail page shows status and offers "Publish now" again.
        }
      }
      router.push(`/posts/${post.id}`);
    } catch (e) {
      setSubmitting(null);
      if (e instanceof ApiError && e.status === 400) {
        const te = extractTargetErrors(e.body);
        if (te) {
          const known: Record<string, string[]> = {};
          const other: string[] = [];
          for (const [k, v] of Object.entries(te)) {
            if (targets[k]) known[k] = v;
            else other.push(...v);
          }
          setErrors(known);
          // Open panels that have errors so they're visible.
          setTargets((prev) => {
            const next = { ...prev };
            for (const k of Object.keys(known)) if (next[k]) next[k] = { ...next[k], open: true };
            return next;
          });
          setFormError(
            other.length
              ? other.join(" ")
              : `Some destinations need changes (${Object.keys(known).length}). See the highlighted panels below.`,
          );
          return;
        }
      }
      setFormError(e instanceof Error ? e.message : "Could not create the post.");
    }
  }

  // ---------- render ----------
  if (loadError) return <Alert tone="error">Could not load your accounts: {loadError}</Alert>;
  if (!accounts) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Spinner /> Loading…
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <Card>
        <div className="flex flex-col items-center py-10 text-center">
          <div className="flex gap-1.5">
            {PLATFORMS.map((p) => (
              <PlatformIcon key={p} platform={p} />
            ))}
          </div>
          <h2 className="mt-5 text-lg font-semibold text-gray-900">Connect an account to start posting</h2>
          <p className="mt-1 max-w-md text-sm text-gray-500">
            Link Facebook, Instagram, LinkedIn, YouTube or TikTok. Without API keys, connecting creates demo accounts so you can try the whole flow.
          </p>
          <Link href="/accounts" className={buttonClasses("primary", "md", "mt-6")}>
            Connect accounts
          </Link>
        </div>
      </Card>
    );
  }

  const uploading = media.some((m) => m.status === "uploading");

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-6">
        {/* Content */}
        <Card title="Content" description="Write once; customise per platform below if needed.">
          <label htmlFor="base-text" className="sr-only">
            Post text
          </label>
          <textarea
            id="base-text"
            value={baseText}
            onChange={(e) => setBaseText(e.target.value)}
            rows={7}
            placeholder="What do you want to share?"
            className={`${fieldClass} resize-y leading-relaxed`}
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-gray-400">{baseText.length.toLocaleString()} characters</span>
            <div className="flex flex-wrap gap-3">
              {selectedIds.length === 0 && <span className="text-xs text-gray-400">Select accounts to see per-platform limits</span>}
              {Array.from(new Set(selectedIds.map((id) => accountById.get(id)!.platform)))
                .filter((p) => selectedIds.some((id) => accountById.get(id)!.platform === p && !targets[id]?.customText))
                .map((p) => (
                  <span key={p} className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: PLATFORM_UI[p].color }} aria-hidden="true" />
                    <span className="text-xs text-gray-500">{PLATFORM_UI[p].label}</span>
                    <Counter value={baseText.length} max={PLATFORM_UI[p].maxText} />
                  </span>
                ))}
            </div>
          </div>

          {/* Media */}
          <div className="mt-5">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`rounded-xl border-2 border-dashed px-4 py-5 text-center transition-colors ${
                dragging ? "border-indigo-400 bg-indigo-50" : "border-gray-200 bg-gray-50"
              }`}
            >
              <input
                ref={fileInput}
                type="file"
                accept={ACCEPT}
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) void uploadFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <p className="text-sm text-gray-600">
                Drag images or videos here, or{" "}
                <button type="button" onClick={() => fileInput.current?.click()} className="font-medium text-indigo-600 hover:text-indigo-500">
                  browse
                </button>
              </p>
              <p className="mt-1 text-xs text-gray-400">JPEG, PNG, WebP, GIF, MP4, MOV</p>
            </div>

            {media.length > 0 && (
              <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {media.map((m, i) => (
                  <li key={m.key} className="group relative overflow-hidden rounded-xl border border-gray-200 bg-white">
                    <div className="relative aspect-square bg-gray-100">
                      {m.mime_type.startsWith("image/") && (m.previewUrl || m.public_url) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={m.previewUrl ?? m.public_url ?? ""} alt={m.filename} className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-gray-500">
                          <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                            <rect x="2" y="5" width="15" height="14" rx="2" />
                            <path d="m17 10 5-3v10l-5-3" strokeLinejoin="round" />
                          </svg>
                          <span className="text-xs font-medium">Video</span>
                        </div>
                      )}
                      {m.status === "uploading" && (
                        <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-indigo-600">
                          <Spinner className="h-6 w-6" />
                        </div>
                      )}
                      {m.status === "error" && (
                        <div className="absolute inset-0 flex items-center justify-center bg-red-50/90 p-2 text-center text-xs font-medium text-red-700">
                          {m.error ?? "Upload failed"}
                        </div>
                      )}
                      <span className="absolute left-1.5 top-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
                        {i + 1}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeMedia(m.key)}
                        className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
                        aria-label={`Remove ${m.filename}`}
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                          <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                    <div className="flex items-center justify-between gap-1 px-2 py-1.5">
                      <span className="truncate text-xs text-gray-600" title={m.filename}>
                        {m.filename}
                      </span>
                      {media.length > 1 && (
                        <span className="flex shrink-0">
                          <button type="button" onClick={() => moveMedia(m.key, -1)} disabled={i === 0} className="px-1 text-gray-400 hover:text-gray-700 disabled:opacity-30" aria-label="Move earlier">
                            ‹
                          </button>
                          <button
                            type="button"
                            onClick={() => moveMedia(m.key, 1)}
                            disabled={i === media.length - 1}
                            className="px-1 text-gray-400 hover:text-gray-700 disabled:opacity-30"
                            aria-label="Move later"
                          >
                            ›
                          </button>
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        {/* Destinations */}
        <Card
          title="Post to"
          description={`${selectedIds.length} of ${accounts.length} account${accounts.length === 1 ? "" : "s"} selected`}
          actions={
            <Link href="/accounts" className="text-sm font-medium text-indigo-600 hover:text-indigo-500">
              Manage
            </Link>
          }
        >
          <div className="space-y-5">
            {grouped.map(({ platform, accounts: list }) => {
              const active = list.filter((a) => a.status === "active");
              const allOn = active.length > 0 && active.every((a) => targets[a.id]);
              return (
                <div key={platform}>
                  <div className="mb-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <PlatformIcon platform={platform} size="sm" />
                      <span className="text-sm font-semibold text-gray-800">{PLATFORM_UI[platform].label}</span>
                    </div>
                    {active.length > 1 && (
                      <button type="button" onClick={() => togglePlatform(platform, !allOn)} className="text-xs font-medium text-indigo-600 hover:text-indigo-500">
                        {allOn ? "Clear" : "Select all"}
                      </button>
                    )}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {list.map((a) => {
                      const checked = !!targets[a.id];
                      const disabled = a.status !== "active";
                      return (
                        <label
                          key={a.id}
                          className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
                            disabled
                              ? "cursor-not-allowed border-gray-200 bg-gray-50 opacity-70"
                              : checked
                                ? "cursor-pointer border-indigo-300 bg-indigo-50/60 ring-1 ring-indigo-200"
                                : "cursor-pointer border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-gray-300 accent-indigo-600"
                            checked={checked}
                            disabled={disabled}
                            onChange={(e) => toggleAccount(a, e.target.checked)}
                          />
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: PLATFORM_UI[a.platform].color }} aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800">{a.display_name}</span>
                          {a.is_demo && <span className="rounded-full bg-yellow-100 px-1.5 py-0.5 text-[10px] font-medium text-yellow-800">Demo</span>}
                          {disabled && (
                            <Link href="/accounts" className="text-xs font-medium text-amber-700 hover:underline">
                              Reconnect
                            </Link>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* Per-target customisation */}
        {selectedIds.length > 0 && (
          <Card title="Customize per platform" description="Optional overrides and platform options." padded={false}>
            <ul className="divide-y divide-gray-100">
              {selectedIds.map((id) => {
                const a = accountById.get(id)!;
                const t = targets[id];
                const text = effectiveText(id);
                const hints = hintsFor(a.platform, text, t.options, media);
                const errs = errors[id] ?? [];
                const hasError = errs.length > 0 || hints.some((h) => h.level === "error");
                return (
                  <li key={id} className={errs.length ? "bg-red-50/40" : ""}>
                    <button
                      type="button"
                      onClick={() => updateTarget(id, { open: !t.open })}
                      className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-gray-50"
                      aria-expanded={t.open}
                    >
                      <PlatformIcon platform={a.platform} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-gray-900">{a.display_name}</span>
                        <span className="block text-xs text-gray-500">
                          {PLATFORM_UI[a.platform].label}
                          {t.customText ? " · custom text" : ""}
                        </span>
                      </span>
                      {hasError && (
                        <span className="h-2 w-2 rounded-full bg-red-500" title="Needs attention" aria-label="Needs attention" />
                      )}
                      <Counter value={text.length} max={PLATFORM_UI[a.platform].maxText} />
                      <svg
                        viewBox="0 0 24 24"
                        className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${t.open ? "rotate-180" : ""}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                      >
                        <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>

                    {(errs.length > 0 || hints.length > 0) && (
                      <ul className="space-y-1 px-5 pb-3">
                        {errs.map((m, i) => (
                          <li key={`e${i}`} className="flex items-start gap-2 text-xs font-medium text-red-700">
                            <span aria-hidden="true">●</span>
                            {m}
                          </li>
                        ))}
                        {hints.map((h, i) => (
                          <li key={`h${i}`} className={`flex items-start gap-2 text-xs ${h.level === "error" ? "text-red-600" : "text-amber-700"}`}>
                            <span aria-hidden="true">{h.level === "error" ? "!" : "·"}</span>
                            {h.msg}
                          </li>
                        ))}
                      </ul>
                    )}

                    {t.open && (
                      <div className="space-y-4 border-t border-gray-100 bg-gray-50/60 px-5 py-4">
                        {a.platform === "youtube" && (
                          <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
                            <label className="block">
                              <span className="flex items-center justify-between text-xs font-medium text-gray-700">
                                <span>
                                  Title <span className="text-red-600">*</span>
                                </span>
                                <Counter value={(t.options.title ?? "").length} max={YOUTUBE_TITLE_MAX} />
                              </span>
                              <input
                                className={`${fieldClass} mt-1`}
                                value={t.options.title ?? ""}
                                onChange={(e) => updateOptions(id, { title: e.target.value })}
                                placeholder="Video title"
                                required
                              />
                            </label>
                            <label className="block">
                              <span className="text-xs font-medium text-gray-700">Privacy</span>
                              <select
                                className={`${fieldClass} mt-1`}
                                value={t.options.privacy ?? "public"}
                                onChange={(e) => updateOptions(id, { privacy: e.target.value as TargetOptions["privacy"] })}
                              >
                                <option value="public">Public</option>
                                <option value="unlisted">Unlisted</option>
                                <option value="private">Private</option>
                              </select>
                            </label>
                          </div>
                        )}
                        {a.platform === "tiktok" && (
                          <label className="block sm:max-w-xs">
                            <span className="text-xs font-medium text-gray-700">Who can view</span>
                            <select
                              className={`${fieldClass} mt-1`}
                              value={t.options.privacy ?? "self_only"}
                              onChange={(e) => updateOptions(id, { privacy: e.target.value as TargetOptions["privacy"] })}
                            >
                              <option value="public">Public</option>
                              <option value="friends">Friends</option>
                              <option value="self_only">Only me</option>
                            </select>
                            <span className="mt-1 block text-xs text-gray-400">Unaudited TikTok apps can only post as “Only me”.</span>
                          </label>
                        )}
                        {a.platform === "instagram" && (
                          <fieldset>
                            <legend className="text-xs font-medium text-gray-700">Post type</legend>
                            <div className="mt-1 inline-flex rounded-lg border border-gray-300 bg-white p-0.5">
                              {(["feed", "reel", "story"] as const).map((v) => (
                                <button
                                  key={v}
                                  type="button"
                                  onClick={() => updateOptions(id, { ig_type: v })}
                                  className={`rounded-md px-3 py-1 text-sm font-medium capitalize ${
                                    (t.options.ig_type ?? "feed") === v ? "bg-indigo-600 text-white" : "text-gray-600 hover:bg-gray-100"
                                  }`}
                                  aria-pressed={(t.options.ig_type ?? "feed") === v}
                                >
                                  {v}
                                </button>
                              ))}
                            </div>
                          </fieldset>
                        )}
                        {a.platform === "facebook" && (
                          <label className="block">
                            <span className="text-xs font-medium text-gray-700">Link (optional)</span>
                            <input
                              className={`${fieldClass} mt-1`}
                              type="url"
                              value={t.options.link ?? ""}
                              onChange={(e) => updateOptions(id, { link: e.target.value })}
                              placeholder="https://example.com/article"
                            />
                          </label>
                        )}

                        <div>
                          <label className="flex items-center gap-2 text-sm text-gray-700">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-gray-300 accent-indigo-600"
                              checked={t.customText}
                              onChange={(e) =>
                                updateTarget(id, { customText: e.target.checked, text: e.target.checked && !t.text ? baseText : t.text })
                              }
                            />
                            {a.platform === "youtube" ? "Custom description for this channel" : `Custom text for ${PLATFORM_UI[a.platform].label}`}
                          </label>
                          {t.customText && (
                            <div className="mt-2">
                              <textarea
                                value={t.text}
                                onChange={(e) => updateTarget(id, { text: e.target.value })}
                                rows={5}
                                className={`${fieldClass} resize-y`}
                                aria-label={`Custom text for ${a.display_name}`}
                              />
                              <div className="mt-1 flex justify-end">
                                <Counter
                                  value={t.text.length}
                                  max={PLATFORM_UI[a.platform].maxText}
                                  label={a.platform === "youtube" ? "Description" : undefined}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>

      {/* Sidebar: schedule + submit */}
      <div className="space-y-6 lg:sticky lg:top-10 lg:self-start">
        <Card title="When">
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-gray-100 p-1" role="radiogroup" aria-label="When to publish">
            {(["now", "schedule"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={when === v}
                onClick={() => {
                  setWhen(v);
                  if (v === "schedule" && !scheduleLocal) {
                    const d = new Date(Date.now() + 60 * 60_000);
                    d.setMinutes(0, 0, 0);
                    setScheduleLocal(toLocalInputValue(d));
                  }
                }}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  when === v ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"
                }`}
              >
                {v === "now" ? "Post now" : "Schedule"}
              </button>
            ))}
          </div>
          {when === "schedule" && (
            <label className="mt-4 block">
              <span className="text-xs font-medium text-gray-700">Date &amp; time</span>
              <input
                type="datetime-local"
                className={`${fieldClass} mt-1`}
                value={scheduleLocal}
                min={minLocal || undefined}
                onChange={(e) => setScheduleLocal(e.target.value)}
              />
              {timeZone && <span className="mt-1 block text-xs text-gray-400">Your local time ({timeZone})</span>}
            </label>
          )}

          {formError && (
            <Alert tone="error" className="mt-4">
              {formError}
            </Alert>
          )}

          <div className="mt-5 flex flex-col gap-2">
            <Button size="lg" onClick={() => submit("publish")} loading={submitting === "publish"} disabled={!!submitting || uploading}>
              {when === "now" ? "Post now" : "Schedule post"}
            </Button>
            <Button variant="secondary" onClick={() => submit("draft")} loading={submitting === "draft"} disabled={!!submitting || uploading}>
              Save draft
            </Button>
            {uploading && <p className="text-center text-xs text-gray-500">Waiting for uploads…</p>}
          </div>
        </Card>

        {selectedIds.length > 0 && (
          <Card title="Summary">
            <div className="flex flex-wrap gap-1.5">
              {selectedIds.map((id) => {
                const a = accountById.get(id)!;
                return <PlatformBadge key={id} platform={a.platform} label={a.display_name} />;
              })}
            </div>
            <p className="mt-3 text-xs text-gray-500">
              {media.filter((m) => m.status === "done").length} media · {when === "now" ? "publishes immediately" : "scheduled"}
            </p>
            {accounts.some((a) => a.is_demo && targets[a.id]) && (
              <div className="mt-3 flex items-center gap-2 text-xs text-gray-500">
                <DemoBadge /> some destinations are simulated
              </div>
            )}
          </Card>
        )}

        <div className="rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-900">
          <span className="font-semibold">Demo tip:</span> include{" "}
          <code className="rounded bg-white/70 px-1 font-mono text-xs">#fail</code> to simulate a retryable error,{" "}
          <code className="rounded bg-white/70 px-1 font-mono text-xs">#fatal</code> for a permanent one.
        </div>
      </div>
    </div>
  );
}
