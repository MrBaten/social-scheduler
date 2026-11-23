"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApDraft } from "@/lib/autopilot/types";
import { api } from "../api";
import { Spinner } from "../Button";
import { Alert, Card } from "../Card";
import { DraftCard } from "./DraftCard";
import { RunNowButton } from "./RunNowButton";
import { errorText } from "./shared";

export function InboxView({ id }: { id: string }) {
  const params = useSearchParams();
  const created = params.get("created") === "1";
  const [drafts, setDrafts] = useState<ApDraft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Keep cards the user is working on (approved / edited) even if the next poll no longer lists them.
  const pinned = useRef(new Map<string, ApDraft>());

  const load = useCallback(async () => {
    try {
      const r = await api<{ drafts: ApDraft[] }>(`/api/autopilot/${id}/drafts?status=in_review`);
      setDrafts((prev) => {
        const fresh = r.drafts ?? [];
        const ids = new Set(fresh.map((d) => d.id));
        const keep = (prev ?? []).filter((d) => !ids.has(d.id) && pinned.current.has(d.id));
        // Existing cards keep their own state; only new drafts are added.
        const known = new Map((prev ?? []).map((d) => [d.id, d]));
        return [...fresh.map((d) => known.get(d.id) ?? d), ...keep];
      });
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="space-y-4">
      {created && (
        <Alert tone="success">
          Autopilot created. The background worker checks sources every 15 minutes and writes a draft about 20 minutes before each posting slot. Press{" "}
          <strong>Run now</strong> to fetch and draft right away.
        </Alert>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-gray-600">
          {drafts === null ? "" : `${drafts.length} draft${drafts.length === 1 ? "" : "s"} waiting for review · refreshes every 15 s`}
        </p>
        <RunNowButton autopilotId={id} label="Run now (fetch + write a draft)" onDone={load} />
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {drafts === null ? (
        <p className="flex items-center gap-2 py-10 text-sm text-gray-500">
          <Spinner /> Loading drafts…
        </p>
      ) : drafts.length === 0 ? (
        <Card>
          <div className="py-10 text-center">
            <p className="text-sm font-medium text-gray-700">Inbox is empty.</p>
            <p className="mt-1 text-sm text-gray-500">
              New drafts appear here before each posting slot. Use <strong>Run now</strong> to fetch your sources and write one immediately.
            </p>
          </div>
        </Card>
      ) : (
        <div className="space-y-5">
          {drafts.map((d) => (
            <DraftCard
              key={d.id}
              draft={d}
              onChanged={(nd) => {
                pinned.current.set(nd.id, nd);
                setDrafts((prev) => (prev ?? []).map((x) => (x.id === nd.id ? nd : x)));
              }}
              onRemoved={(rid) => {
                pinned.current.delete(rid);
                setDrafts((prev) => (prev ?? []).filter((x) => x.id !== rid));
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
