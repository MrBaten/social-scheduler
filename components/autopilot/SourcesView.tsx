"use client";

import { useCallback, useEffect, useState } from "react";
import type { ApSource } from "@/lib/autopilot/types";
import { api, formatLocal } from "../api";
import { Button, Spinner } from "../Button";
import { Alert, Card } from "../Card";
import { ConfirmButton } from "../ConfirmButton";
import { RunNowButton } from "./RunNowButton";
import { SourceEditor, SourceTestResult, testSource } from "./SourceEditor";
import { SOURCE_TYPE_LABEL, emptySource, errorText, newKey, sourcePayload, type SourceDraft } from "./shared";

interface TopicRow {
  id: string;
  headline: string;
  item_count: number;
  best_score: number;
  status: string;
  last_seen_at: string;
  best_url: string | null;
  best_publisher: string | null;
}

function toDraft(s: ApSource): SourceDraft {
  return { key: s.id, type: s.type, label: s.label, url: s.url ?? "", query: s.query ?? "", params: s.params ?? {} };
}

export function SourcesView({ id }: { id: string }) {
  const [sources, setSources] = useState<ApSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<SourceDraft | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<SourceDraft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ sources: ApSource[] }>(`/api/autopilot/${id}/sources`);
      setSources(r.sources ?? []);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    if (!adding) return;
    setBusy("add");
    setError(null);
    try {
      await api(`/api/autopilot/${id}/sources`, { method: "POST", json: sourcePayload(adding) });
      setAdding(null);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function patch(sourceId: string, body: Record<string, unknown>) {
    setBusy(sourceId);
    setError(null);
    try {
      await api(`/api/autopilot/${id}/sources/${sourceId}`, { method: "PATCH", json: body });
      await load();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function remove(sourceId: string) {
    try {
      await api(`/api/autopilot/${id}/sources/${sourceId}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="error">{error}</Alert>}
      <Card
        title="Sources"
        description="Free sources: RSS feeds, Google News searches and GDELT. A source that fails 5 times in a row is paused and flagged."
        actions={<RunNowButton autopilotId={id} generate={false} onDone={load} />}
      >
        {sources === null ? (
          <p className="flex items-center gap-2 text-sm text-gray-500">
            <Spinner /> Loading…
          </p>
        ) : sources.length === 0 ? (
          <p className="text-sm text-gray-500">No sources yet. Add one below.</p>
        ) : (
          <ul className="space-y-3">
            {sources.map((s) =>
              editing === s.id && editDraft ? (
                <li key={s.id}>
                  <SourceEditor value={editDraft} onChange={setEditDraft} />
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      loading={busy === s.id}
                      onClick={async () => {
                        if (await patch(s.id, sourcePayload(editDraft))) setEditing(null);
                      }}
                    >
                      Save
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                </li>
              ) : (
                <SourceItem
                  key={s.id}
                  s={s}
                  busy={busy === s.id}
                  onToggle={() => patch(s.id, { enabled: !s.enabled })}
                  onEdit={() => {
                    setEditing(s.id);
                    setEditDraft(toDraft(s));
                  }}
                  onDelete={() => remove(s.id)}
                />
              ),
            )}
          </ul>
        )}
      </Card>

      <Card title="Add a source" description="Add the RSS feeds of outlets you trust and test them first. No paid sources in this version.">
        {adding ? (
          <>
            <SourceEditor value={adding} onChange={setAdding} onRemove={() => setAdding(null)} removeLabel="Cancel" />
            <Button className="mt-3" size="sm" loading={busy === "add"} onClick={add}>
              Add source
            </Button>
          </>
        ) : (
          <div className="flex flex-wrap gap-2">
            {(["rss", "google_news", "gdelt"] as const).map((t) => (
              <Button key={t} variant="secondary" size="sm" onClick={() => setAdding({ ...emptySource(t), key: newKey() })}>
                + {SOURCE_TYPE_LABEL[t]}
              </Button>
            ))}
          </div>
        )}
      </Card>

      <TopicsCard id={id} />
    </div>
  );
}

function SourceItem({
  s,
  busy,
  onToggle,
  onEdit,
  onDelete,
}: {
  s: ApSource;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof testSource>> | null>(null);
  const autoPaused = !s.enabled && !!s.last_error && s.error_count >= 5;

  return (
    <li className={`rounded-xl border p-4 ${autoPaused ? "border-red-200 bg-red-50/40" : "border-gray-200"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">{SOURCE_TYPE_LABEL[s.type]}</span>
            <span className="font-medium text-gray-900">{s.label || s.url || s.query}</span>
            {!s.enabled && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">Off</span>}
          </p>
          <p className="mt-1 break-all text-xs text-gray-500">
            {s.type === "rss" ? s.url : s.query}
            {s.type === "google_news" && ` · hl=${s.params.hl ?? "en"} gl=${s.params.gl ?? "BD"}`}
            {s.type === "gdelt" && ` · ${s.params.timespan ?? "1d"}`}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            Every {s.interval_minutes} min · last checked {formatLocal(s.last_fetched_at)} · last OK {formatLocal(s.last_ok_at)} · {s.item_count} item
            {s.item_count === 1 ? "" : "s"} stored
          </p>
          {s.last_error && (
            <p className="mt-1 text-xs text-red-700">
              {s.error_count > 0 && `${s.error_count} failure${s.error_count === 1 ? "" : "s"} in a row: `}
              {s.last_error}
            </p>
          )}
          {autoPaused && <p className="mt-1 text-xs font-medium text-red-800">Paused after 5 failures. Fix it (Edit, then Test) and switch it back on.</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" className="h-4 w-4 rounded border-gray-300" checked={s.enabled} disabled={busy} onChange={onToggle} />
            On
          </label>
          <Button
            variant="secondary"
            size="sm"
            loading={testing}
            onClick={async () => {
              setTesting(true);
              setResult(await testSource({ key: s.id, type: s.type, label: s.label, url: s.url ?? "", query: s.query ?? "", params: s.params }));
              setTesting(false);
            }}
          >
            Test
          </Button>
          <Button variant="ghost" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <ConfirmButton label="Delete" confirmLabel="Delete source" onConfirm={onDelete} />
        </div>
      </div>
      {result && <SourceTestResult result={result} />}
    </li>
  );
}

function TopicsCard({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [topics, setTopics] = useState<TopicRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    api<{ topics: TopicRow[] }>(`/api/autopilot/${id}/topics`)
      .then((r) => setTopics(r.topics ?? []))
      .catch((e: unknown) => setError(errorText(e)));
  }, [open, id]);

  return (
    <Card padded={false}>
      <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer select-none px-5 py-4 text-base font-semibold text-gray-900">
          Recent topics <span className="text-sm font-normal text-gray-500">(stories grouped across outlets, with relevance scores)</span>
        </summary>
        <div className="border-t border-gray-100 px-5 py-4">
          {error && <Alert tone="error">{error}</Alert>}
          {topics === null && !error ? (
            <p className="flex items-center gap-2 text-sm text-gray-500">
              <Spinner /> Loading…
            </p>
          ) : topics && topics.length === 0 ? (
            <p className="text-sm text-gray-500">No topics yet. Fetch your sources first.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Headline</th>
                    <th className="py-2 pr-4 font-medium">Outlets</th>
                    <th className="py-2 pr-4 font-medium">Score</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 font-medium">Last seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(topics ?? []).map((t) => (
                    <tr key={t.id}>
                      <td className="max-w-md py-2 pr-4">
                        {t.best_url ? (
                          <a href={t.best_url} target="_blank" rel="noreferrer noopener" className="text-gray-900 hover:underline">
                            {t.headline}
                          </a>
                        ) : (
                          t.headline
                        )}
                        {t.best_publisher && <span className="text-xs text-gray-500"> · {t.best_publisher}</span>}
                      </td>
                      <td className="py-2 pr-4 text-gray-700">{t.item_count}</td>
                      <td className="py-2 pr-4 font-medium text-gray-900">{Math.round(t.best_score)}</td>
                      <td className="py-2 pr-4">
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">{t.status}</span>
                      </td>
                      <td className="py-2 text-xs text-gray-500">{formatLocal(t.last_seen_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-gray-400">Pinning and blocking topics comes in Phase 2.</p>
            </div>
          )}
        </div>
      </details>
    </Card>
  );
}
