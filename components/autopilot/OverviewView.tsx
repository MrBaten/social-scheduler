"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { AutopilotSummary } from "@/lib/autopilot/types";
import { api, formatLocal } from "../api";
import { Button, buttonClasses, Spinner } from "../Button";
import { Alert, Card } from "../Card";
import { RunNowButton } from "./RunNowButton";
import { LANGUAGE_LABEL, errorText } from "./shared";

interface OverviewData {
  autopilots: AutopilotSummary[];
  paused: boolean;
  ai: { configured: boolean; provider: string; model: string | null; problem: string | null };
  worker_enabled: boolean;
  inbox_total: number;
}

const STAT_LABELS: [keyof AutopilotSummary["today"], string][] = [
  ["found", "Found"],
  ["drafted", "Drafted"],
  ["approved", "Approved"],
  ["published", "Published"],
  ["failed", "Failed"],
];

export function OverviewView() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<OverviewData>("/api/autopilot"));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  async function setGlobal(paused: boolean) {
    setBusy("global");
    try {
      await api("/api/autopilot/settings", { method: "PATCH", json: { paused } });
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function setStatus(id: string, status: "active" | "paused") {
    setBusy(id);
    try {
      await api(`/api/autopilot/${id}`, { method: "PATCH", json: { status } });
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  if (!data) {
    return error ? (
      <Alert tone="error">{error}</Alert>
    ) : (
      <p className="flex items-center gap-2 py-10 text-sm text-gray-500">
        <Spinner /> Loading autopilots…
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="error">{error}</Alert>}
      <Alert tone="info">Phase 1: AutoPilot writes drafts for your Review inbox. Nothing publishes without your approval.</Alert>
      {!data.ai.configured && (
        <Alert tone="warning">
          <strong>AI not configured</strong>: drafts are template-filled from the feed text and flagged &quot;No AI&quot;. {data.ai.problem ? `(${data.ai.problem})` : ""} Add{" "}
          <code>AI_API_KEY</code> (and <code>AI_PROVIDER</code>, <code>AI_MODEL</code>) in Railway Variables.
        </Alert>
      )}
      {data.ai.configured && (
        <p className="text-xs text-gray-500">
          AI: {data.ai.provider}
          {data.ai.model ? ` / ${data.ai.model}` : ""}
        </p>
      )}
      {!data.worker_enabled && (
        <Alert tone="warning">
          <strong>Background worker is off</strong> (set <code>RUN_AUTOPILOT=true</code>): sources are not checked automatically. Use <strong>Run now</strong> to fetch and
          draft by hand.
        </Alert>
      )}

      <Card
        title="All autopilots"
        description={`${data.autopilots.length} autopilot${data.autopilots.length === 1 ? "" : "s"} · ${data.inbox_total} draft${data.inbox_total === 1 ? "" : "s"} waiting for review`}
        actions={
          <div className="flex items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-gray-700">
              <span>{data.paused ? "All paused" : "Global pause"}</span>
              <button
                type="button"
                role="switch"
                aria-checked={data.paused}
                aria-label="Pause all autopilots"
                disabled={busy === "global"}
                onClick={() => setGlobal(!data.paused)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${data.paused ? "bg-red-500" : "bg-gray-300"}`}
              >
                <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${data.paused ? "translate-x-5" : "translate-x-0.5"}`} />
              </button>
            </label>
            <Link href="/autopilot/new" className={buttonClasses("primary", "sm")}>
              New autopilot
            </Link>
          </div>
        }
      >
        {data.paused && (
          <Alert tone="warning" className="mb-4">
            Global pause is on: no drafting for any autopilot. Posts you already approved stay in the Queue.
          </Alert>
        )}
        {data.autopilots.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm text-gray-500">No autopilots yet.</p>
            <Link href="/autopilot/new" className={buttonClasses("primary", "md", "mt-4")}>
              Set up your first autopilot
            </Link>
          </div>
        ) : (
          <ul className="grid gap-4 lg:grid-cols-2">
            {data.autopilots.map((a) => (
              <li key={a.id} className="flex flex-col rounded-xl border border-gray-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link href={`/autopilot/${a.id}/inbox`} className="text-base font-semibold text-gray-900 hover:text-violet-700">
                      {a.name}
                    </Link>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {LANGUAGE_LABEL[a.language]} · every {a.frequency_minutes} min · {a.window_start}–{a.window_end} ({a.timezone})
                    </p>
                  </div>
                  <ApStatus status={a.status} />
                </div>
                {a.status === "paused" && a.paused_reason && <p className="mt-2 text-xs text-amber-800">{a.paused_reason}</p>}
                {a.expired_accounts.length > 0 && (
                  <Alert tone="warning" className="mt-3 text-xs!">
                    Account expired: {a.expired_accounts.join(", ")}.{" "}
                    <Link href="/accounts" className="font-medium underline">
                      Reconnect
                    </Link>
                  </Alert>
                )}
                <dl className="mt-3 grid grid-cols-5 gap-2 text-center">
                  {STAT_LABELS.map(([k, label]) => (
                    <div key={k} className="rounded-lg bg-gray-50 px-1 py-2">
                      <dt className="text-[10px] font-medium uppercase tracking-wide text-gray-500">{label}</dt>
                      <dd className={`text-lg font-semibold ${k === "failed" && a.today[k] > 0 ? "text-red-700" : "text-gray-900"}`}>{a.today[k]}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-1 text-[11px] text-gray-400">Today, in {a.timezone}</p>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  <Link href={`/autopilot/${a.id}/inbox`} className="font-medium text-violet-700 hover:text-violet-600">
                    Inbox: {a.today.inbox}
                  </Link>
                  <span className="text-gray-600">Next slot: {a.next_slot_at ? formatLocal(a.next_slot_at) : "—"}</span>
                  <Link href={`/autopilot/${a.id}/sources`} className={a.sources_failing ? "font-medium text-red-700" : "text-gray-600"}>
                    Sources: {a.sources_count}
                    {a.sources_failing ? ` (${a.sources_failing} failing)` : ""}
                  </Link>
                  <span className="text-gray-500">AI calls today: {a.today.ai_calls}/{a.ai_daily_cap}</span>
                </div>
                <div className="mt-4 flex flex-wrap items-start gap-2 border-t border-gray-100 pt-3">
                  <RunNowButton autopilotId={a.id} onDone={load} />
                  {a.status === "active" ? (
                    <Button variant="secondary" size="sm" loading={busy === a.id} onClick={() => setStatus(a.id, "paused")}>
                      Pause
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" loading={busy === a.id} onClick={() => setStatus(a.id, "active")}>
                      Resume
                    </Button>
                  )}
                  <Link href={`/autopilot/${a.id}/settings`} className={buttonClasses("ghost", "sm")}>
                    Settings
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export function ApStatus({ status }: { status: "active" | "paused" }) {
  return status === "active" ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-green-200 bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
      <span className="h-1.5 w-1.5 rounded-full bg-green-500" aria-hidden="true" />
      Active
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
      Paused
    </span>
  );
}
