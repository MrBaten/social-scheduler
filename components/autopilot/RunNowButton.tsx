"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "../api";
import { Button, type ButtonSize, type ButtonVariant } from "../Button";
import { errorText } from "./shared";

interface RunResult {
  ran: boolean;
  skipped_reason: string | null;
  counts: Record<string, number>;
  draft_id: string | null;
  notes: string[];
  error: string | null;
}

/** POST /api/autopilot/[id]/run. generate=false only fetches sources. */
export function RunNowButton({
  autopilotId,
  generate = true,
  label,
  onDone,
  variant = "secondary",
  size = "sm",
}: {
  autopilotId: string;
  generate?: boolean;
  label?: string;
  onDone?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const r = await api<{ result: RunResult }>(`/api/autopilot/${autopilotId}/run`, { method: "POST", json: { generate } });
      setResult(r.result);
      onDone?.();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const c = result?.counts ?? {};
  return (
    <div className="min-w-0">
      <Button variant={variant} size={size} loading={busy} onClick={run}>
        {busy ? (generate ? "Running… (up to a minute)" : "Fetching…") : (label ?? (generate ? "Run now" : "Fetch now"))}
      </Button>
      {err && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {err}
        </p>
      )}
      {result && (
        <div role="status" className={`mt-2 rounded-lg border px-3 py-2 text-xs ${result.error ? "border-red-200 bg-red-50 text-red-800" : "border-gray-200 bg-gray-50 text-gray-700"}`}>
          <p>
            Fetched {c.sources_fetched ?? 0} source{c.sources_fetched === 1 ? "" : "s"} · {c.items_found ?? 0} new item{c.items_found === 1 ? "" : "s"} ·{" "}
            {c.duplicates ?? 0} duplicate{c.duplicates === 1 ? "" : "s"} · {c.new_topics ?? 0} new topic{c.new_topics === 1 ? "" : "s"} · {c.archived ?? 0} archived
          </p>
          {result.draft_id && (
            <p className="mt-1 font-medium text-green-800">
              Draft written.{" "}
              <Link href={`/autopilot/${autopilotId}/inbox`} className="underline">
                Open the inbox
              </Link>
            </p>
          )}
          {result.error && <p className="mt-1 font-medium">Error: {result.error}</p>}
          {result.notes.map((n, i) => (
            <p key={i} className="mt-1">
              {n}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
