"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { ApDraft, ApRun, ApSource, ApPlatform } from "@/lib/autopilot/types";
import type { TargetStatus } from "@/lib/types";
import { api, formatLocal } from "../api";
import { Spinner } from "../Button";
import { Alert, Card } from "../Card";
import { PlatformBadge } from "../PlatformBadge";
import { errorText } from "./shared";

interface ReviewedDraft extends ApDraft {
  post: null | {
    id: string;
    status: string;
    scheduled_at: string | null;
    targets: { platform: ApPlatform; account: string; status: TargetStatus; url: string | null; error: string | null; published_at: string | null }[];
  };
}

interface ActivityData {
  runs: ApRun[];
  reviewed: ReviewedDraft[];
  failing_sources: ApSource[];
  archived: { reason: string | null; n: number }[];
}

const ARCHIVE_LABEL: Record<string, string> = {
  banned: "Banned word or topic",
  too_old: "Too old",
  low_score: "Low relevance",
};

const DRAFT_STATUS: Record<string, string> = {
  scheduled: "bg-indigo-100 text-indigo-800 border-indigo-200",
  approved: "bg-green-100 text-green-800 border-green-200",
  rejected: "bg-red-100 text-red-800 border-red-200",
  in_review: "bg-gray-100 text-gray-700 border-gray-200",
};

export function ActivityView({ id }: { id: string }) {
  const [data, setData] = useState<ActivityData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<ActivityData>(`/api/autopilot/${id}/activity`));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (!data) {
    return error ? (
      <Alert tone="error">{error}</Alert>
    ) : (
      <p className="flex items-center gap-2 py-10 text-sm text-gray-500">
        <Spinner /> Loading activity…
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="error">{error}</Alert>}

      {data.failing_sources.length > 0 && (
        <Card title="Failing sources">
          <ul className="space-y-2 text-sm">
            {data.failing_sources.map((s) => (
              <li key={s.id}>
                <Link href={`/autopilot/${id}/sources`} className="font-medium text-gray-900 hover:underline">
                  {s.label || s.url || s.query}
                </Link>
                {!s.enabled && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">paused</span>}
                <p className="text-xs text-red-700">
                  {s.error_count} failure{s.error_count === 1 ? "" : "s"}: {s.last_error}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Reviewed drafts" description="Approved, scheduled and rejected drafts, with what happened to the post." padded={false}>
        {data.reviewed.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-500">Nothing reviewed yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {data.reviewed.map((d) => (
              <li key={d.id} className="px-5 py-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${DRAFT_STATUS[d.status] ?? DRAFT_STATUS.in_review}`}>
                    {d.status.replace("_", " ")}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">{d.headline}</span>
                  <span className="text-xs text-gray-500">{formatLocal(d.reviewed_at)}</span>
                </div>
                {d.status === "rejected" && <p className="mt-1 text-xs text-gray-600">Reason: {d.reject_reason || "none given"}</p>}
                {d.post ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                    <Link href={`/posts/${d.post.id}`} className="font-medium text-indigo-700 hover:text-indigo-600">
                      Post: {d.post.status}
                    </Link>
                    {d.post.scheduled_at && <span className="text-gray-500">· {formatLocal(d.post.scheduled_at)}</span>}
                    {d.post.targets.map((t, i) =>
                      t.url ? (
                        <a key={i} href={t.url} target="_blank" rel="noreferrer noopener" title={t.error ?? undefined}>
                          <PlatformBadge platform={t.platform} status={t.status} label={`${t.account} ↗`} />
                        </a>
                      ) : (
                        <span key={i} title={t.error ?? undefined}>
                          <PlatformBadge platform={t.platform} status={t.status} label={t.account} />
                        </span>
                      ),
                    )}
                  </div>
                ) : (
                  d.post_id === null &&
                  d.status !== "rejected" && <p className="mt-1 text-xs text-gray-500">The post was deleted from the Queue.</p>
                )}
                {d.post?.targets
                  .filter((t) => t.error && t.status === "failed")
                  .map((t, i) => (
                    <p key={i} className="mt-1 text-xs text-red-700">
                      {t.platform}: {t.error}
                    </p>
                  ))}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Run log" description="Worker runs that did something, plus every Run now." padded={false}>
        {data.runs.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-500">No runs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-5 py-2 font-medium">Started</th>
                  <th className="px-3 py-2 font-medium">Trigger</th>
                  <th className="px-3 py-2 font-medium">Steps</th>
                  <th className="px-3 py-2 font-medium">New items</th>
                  <th className="px-3 py-2 font-medium">Dupes</th>
                  <th className="px-3 py-2 font-medium">Archived</th>
                  <th className="px-3 py-2 font-medium">Topics</th>
                  <th className="px-3 py-2 font-medium">Drafts</th>
                  <th className="px-3 py-2 font-medium">AI</th>
                  <th className="px-5 py-2 font-medium">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.runs.map((r) => (
                  <tr key={r.id} className={r.error ? "bg-red-50/50" : ""}>
                    <td className="whitespace-nowrap px-5 py-2 text-gray-700">{formatLocal(r.started_at)}</td>
                    <td className="px-3 py-2 text-gray-600">{r.trigger}</td>
                    <td className="px-3 py-2 text-gray-600">{r.step}</td>
                    <td className="px-3 py-2">{r.counts.items_found ?? "—"}</td>
                    <td className="px-3 py-2">{r.counts.duplicates ?? "—"}</td>
                    <td className="px-3 py-2">{r.counts.archived ?? "—"}</td>
                    <td className="px-3 py-2">{r.counts.new_topics ?? "—"}</td>
                    <td className="px-3 py-2">{r.counts.drafts ?? "—"}</td>
                    <td className="px-3 py-2">{r.ai_calls}</td>
                    <td className="max-w-xs px-5 py-2 text-xs text-red-700">{r.error ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Archived stories" description="Stories that were stored but never drafted (kept, not deleted).">
        {data.archived.length === 0 ? (
          <p className="text-sm text-gray-500">None yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-3 text-sm">
            {data.archived.map((a) => (
              <li key={a.reason ?? "other"} className="rounded-lg bg-gray-50 px-3 py-2">
                <span className="font-semibold text-gray-900">{a.n}</span> <span className="text-gray-600">{ARCHIVE_LABEL[a.reason ?? ""] ?? a.reason ?? "Other"}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
