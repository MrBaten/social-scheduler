"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { ApDraft, ApPlatform, DraftTexts } from "@/lib/autopilot/types";
import type { PostWithTargets } from "@/lib/types";
import { ApiError, api, extractTargetErrors, formatLocal } from "../api";
import { Button } from "../Button";
import { PlatformIcon } from "../PlatformBadge";
import { PLATFORM_UI } from "../platforms";
import { AP_PLATFORM_LIST, PLATFORM_LIMITS, errorText, inputClass, labelClass, localInputToIso } from "./shared";

type When = "slot" | "now" | "custom" | "queue_draft";

interface ApproveResponse {
  draft: ApDraft;
  post: PostWithTargets;
  skipped: { account: string; platform: string; reason: string }[];
}

const WHEN_LABEL: Record<When, string> = {
  slot: "Next free slot",
  now: "Now",
  custom: "Pick a time",
  queue_draft: "Save as draft in Queue",
};

export function DraftCard({ draft, onChanged, onRemoved }: { draft: ApDraft; onChanged: (d: ApDraft) => void; onRemoved: (id: string) => void }) {
  const platforms = AP_PLATFORM_LIST.filter((p) => draft.texts[p] !== undefined);
  const [tab, setTab] = useState<ApPlatform>(platforms[0] ?? "facebook");
  const [texts, setTexts] = useState<DraftTexts>(draft.texts);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "approve" | "regen" | "reject" | "image">(null);
  const [error, setError] = useState<string | null>(null);
  const [targetErrors, setTargetErrors] = useState<Record<string, string[]> | null>(null);
  const [when, setWhen] = useState<When>("slot");
  const [customAt, setCustomAt] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [approved, setApproved] = useState<ApproveResponse | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const noAi = draft.qc_flags.some((f) => f.code === "no_ai");
  const otherFlags = draft.qc_flags.filter((f) => f.code !== "no_ai");

  async function save(): Promise<boolean> {
    if (!dirty) return true;
    setBusy("save");
    setError(null);
    try {
      const r = await api<{ draft: ApDraft }>(`/api/autopilot/drafts/${draft.id}`, { method: "PATCH", json: { texts } });
      setDirty(false);
      onChanged(r.draft);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    setError(null);
    setTargetErrors(null);
    if (!(await save())) return;
    let scheduled_at: string | undefined;
    if (when === "custom") {
      const iso = localInputToIso(customAt);
      if (!iso) {
        setError("Pick a date and time.");
        return;
      }
      scheduled_at = iso;
    }
    setBusy("approve");
    try {
      const r = await api<ApproveResponse>(`/api/autopilot/drafts/${draft.id}/approve`, { method: "POST", json: { when, scheduled_at } });
      setApproved(r);
      onChanged(r.draft); // keeps this card (with its confirmation) on screen after the next refresh
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError) setTargetErrors(extractTargetErrors(e.body));
    } finally {
      setBusy(null);
    }
  }

  async function regenerate() {
    setBusy("regen");
    setError(null);
    try {
      const r = await api<{ draft: ApDraft }>(`/api/autopilot/drafts/${draft.id}/regenerate`, { method: "POST" });
      setTexts(r.draft.texts);
      setDirty(false);
      onChanged(r.draft);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    setBusy("reject");
    setError(null);
    try {
      await api(`/api/autopilot/drafts/${draft.id}/reject`, { method: "POST", json: { reason } });
      onRemoved(draft.id);
    } catch (e) {
      setError(errorText(e));
      setBusy(null);
    }
  }

  async function attach(file: File) {
    setBusy("image");
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const m = await api<{ media: { id: string } }>("/api/media", { method: "POST", body: fd });
      const r = await api<{ draft: ApDraft }>(`/api/autopilot/drafts/${draft.id}`, { method: "PATCH", json: { image_media_id: m.media.id } });
      onChanged(r.draft);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removeImage() {
    setBusy("image");
    try {
      const r = await api<{ draft: ApDraft }>(`/api/autopilot/drafts/${draft.id}`, { method: "PATCH", json: { image_media_id: null } });
      onChanged(r.draft);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  if (approved) {
    return (
      <article className="rounded-xl border border-green-200 bg-green-50 p-5 text-sm text-green-900">
        <p className="font-semibold">Approved: {draft.headline}</p>
        <p className="mt-1">
          {approved.post.scheduled_at ? `Scheduled for ${formatLocal(approved.post.scheduled_at)}.` : "Saved as a draft in your Queue."}{" "}
          <Link href={`/posts/${approved.post.id}`} className="font-medium underline">
            Open the post
          </Link>
        </p>
        {approved.skipped.length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-amber-800">
            {approved.skipped.map((s, i) => (
              <li key={i}>
                Left out {s.account} ({s.platform}): {s.reason}
              </li>
            ))}
          </ul>
        )}
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => onRemoved(draft.id)}>
          Dismiss
        </Button>
      </article>
    );
  }

  const text = texts[tab] ?? "";
  const limit = PLATFORM_LIMITS[tab];

  return (
    <article className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <header className="border-b border-gray-100 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {noAi ? (
            <span className="rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">No AI</span>
          ) : (
            <span className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 font-medium text-violet-800">{draft.generator || "AI"}</span>
          )}
          {draft.template_name && <span className="text-gray-500">Template: {draft.template_name}</span>}
          <span className="text-gray-500">Written {formatLocal(draft.created_at)}</span>
          {draft.slot_at && <span className="text-gray-500">· for slot {formatLocal(draft.slot_at)}</span>}
          <span className="ml-auto text-gray-400">QC score: Phase 2</span>
        </div>
        <h2 className="mt-2 text-base font-semibold text-gray-900">{draft.headline}</h2>
        <p className="mt-1 text-sm">
          <a href={draft.source_url} target="_blank" rel="noreferrer noopener" className="font-medium text-indigo-700 hover:text-indigo-600">
            {draft.source_name || "Source"} ↗
          </a>
        </p>
        {draft.source_summary && <p className="mt-1 text-sm text-gray-600">{draft.source_summary}</p>}
        {draft.related.length > 0 && (
          <details className="mt-2 text-xs text-gray-600">
            <summary className="cursor-pointer select-none font-medium">Also covered by {draft.related.length} other outlet{draft.related.length === 1 ? "" : "s"}</summary>
            <ul className="mt-1 space-y-0.5 pl-4">
              {draft.related.map((r, i) => (
                <li key={`${r.url}-${i}`} className="truncate">
                  <a href={r.url} target="_blank" rel="noreferrer noopener" className="hover:underline">
                    {r.publisher || "outlet"}: {r.title}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        )}
        {(noAi || otherFlags.length > 0) && (
          <ul className="mt-3 space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {draft.qc_flags.map((f, i) => (
              <li key={i}>⚠ {f.message}</li>
            ))}
          </ul>
        )}
      </header>

      <div className="px-5 py-4">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Platform">
          {platforms.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={tab === p}
              onClick={() => setTab(p)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium ${tab === p ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}
            >
              <PlatformIcon platform={p} size="sm" />
              {PLATFORM_UI[p].label}
              {(texts[p]?.length ?? 0) > PLATFORM_LIMITS[p] && <span className="text-red-400">!</span>}
            </button>
          ))}
        </div>
        <label htmlFor={`${draft.id}-${tab}`} className="sr-only">
          {PLATFORM_UI[tab].label} text
        </label>
        <textarea
          id={`${draft.id}-${tab}`}
          rows={9}
          className={`${inputClass} mt-3`}
          value={text}
          onChange={(e) => {
            setTexts((prev) => ({ ...prev, [tab]: e.target.value }));
            setDirty(true);
          }}
        />
        <div className="mt-1 flex items-center justify-between text-xs">
          <span className={text.length > limit ? "font-semibold text-red-700" : "text-gray-500"}>
            {text.length.toLocaleString()} / {limit.toLocaleString()} characters
          </span>
          {dirty && (
            <Button variant="ghost" size="sm" loading={busy === "save"} onClick={() => void save()}>
              Save edits
            </Button>
          )}
        </div>
        {targetErrors && (
          <ul className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
            {Object.entries(targetErrors).flatMap(([k, list]) => list.map((m, i) => <li key={`${k}-${i}`}>{m}</li>))}
          </ul>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-gray-50 px-3 py-2">
          {draft.image ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={draft.image.public_url} alt="Attached" className="h-14 w-14 rounded-md object-cover" />
              <span className="text-xs text-gray-600">{draft.image.mime_type === "image/jpeg" ? "Image attached (JPEG, OK for Instagram)" : `Image attached (${draft.image.mime_type}; Instagram needs JPEG)`}</span>
              <Button variant="ghost" size="sm" loading={busy === "image"} onClick={removeImage}>
                Remove image
              </Button>
            </>
          ) : (
            <>
              <span className="text-xs text-gray-600">
                No image. {platforms.includes("instagram") ? "Instagram is skipped unless you attach one (JPEG)." : "Optional."}
              </span>
              <label className="cursor-pointer text-sm font-medium text-indigo-700 hover:text-indigo-600">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="sr-only"
                  disabled={busy !== null}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void attach(f);
                  }}
                />
                {busy === "image" ? "Uploading…" : "Attach image"}
              </label>
            </>
          )}
        </div>
      </div>

      <footer className="flex flex-col gap-3 border-t border-gray-100 px-5 py-4">
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        {rejecting ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-60 flex-1">
              <label htmlFor={`${draft.id}-reason`} className={labelClass}>
                Reason (helps tune the autopilot)
              </label>
              <input
                id={`${draft.id}-reason`}
                className={`${inputClass} mt-1`}
                value={reason}
                maxLength={500}
                placeholder="e.g. off-topic, wrong facts, too salesy"
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <Button variant="danger" size="md" loading={busy === "reject"} onClick={reject}>
              Reject draft
            </Button>
            <Button variant="ghost" size="md" disabled={busy === "reject"} onClick={() => setRejecting(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor={`${draft.id}-when`} className={labelClass}>
                When
              </label>
              <select id={`${draft.id}-when`} className={`${inputClass} mt-1 w-auto`} value={when} onChange={(e) => setWhen(e.target.value as When)}>
                {(Object.keys(WHEN_LABEL) as When[]).map((w) => (
                  <option key={w} value={w}>
                    {WHEN_LABEL[w]}
                  </option>
                ))}
              </select>
            </div>
            {when === "custom" && (
              <div>
                <label htmlFor={`${draft.id}-at`} className={labelClass}>
                  Date and time
                </label>
                <input id={`${draft.id}-at`} type="datetime-local" className={`${inputClass} mt-1 w-auto`} value={customAt} onChange={(e) => setCustomAt(e.target.value)} />
              </div>
            )}
            <Button loading={busy === "approve"} disabled={busy !== null && busy !== "approve"} onClick={approve}>
              Approve
            </Button>
            <Button variant="secondary" loading={busy === "regen"} disabled={busy !== null && busy !== "regen"} onClick={regenerate}>
              Regenerate
            </Button>
            <Button variant="secondary" className="text-red-700" disabled={busy !== null} onClick={() => setRejecting(true)}>
              Reject
            </Button>
          </div>
        )}
        <p className="text-xs text-gray-500">Approving puts a normal post in your Queue. Your edits are saved first.</p>
      </footer>
    </article>
  );
}
