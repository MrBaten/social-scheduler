"use client";

import { useState } from "react";
import type { ApSourceType, FeedItem } from "@/lib/autopilot/types";
import { api, formatLocal } from "../api";
import { Button } from "../Button";
import { SOURCE_TYPE_LABEL, errorText, hintClass, inputClass, labelClass, sourcePayload, type SourceDraft } from "./shared";

interface TestResult {
  ok: boolean;
  request_url: string;
  count: number;
  items: FeedItem[];
  error?: string;
}

/** Result box of POST /api/autopilot/sources/test. */
export function SourceTestResult({ result }: { result: TestResult | { ok: false; error: string; count: 0; items: []; request_url: "" } }) {
  if (!result.ok) {
    return (
      <div role="alert" className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
        <p className="font-semibold">Test failed</p>
        <p className="mt-0.5 break-words">{result.error}</p>
        {result.request_url && <p className="mt-1 break-all text-red-700/80">{result.request_url}</p>}
      </div>
    );
  }
  return (
    <div role="status" className="mt-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900">
      <p className="font-semibold">
        Works: {result.count} item{result.count === 1 ? "" : "s"} found
      </p>
      {result.items.length > 0 && (
        <ul className="mt-1 space-y-1">
          {result.items.slice(0, 5).map((it, i) => (
            <li key={`${it.url}-${i}`} className="truncate">
              <a href={it.url} target="_blank" rel="noreferrer noopener" className="underline decoration-green-300 hover:decoration-green-700">
                {it.title}
              </a>
              <span className="text-green-800/70">
                {" "}
                · {it.publisher || "unknown"}
                {it.published_at ? ` · ${formatLocal(it.published_at)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {result.count === 0 && <p className="mt-0.5">The source answered but had no items. Try a broader query.</p>}
    </div>
  );
}

export async function testSource(s: SourceDraft): Promise<TestResult> {
  try {
    return await api<TestResult>("/api/autopilot/sources/test", { method: "POST", json: sourcePayload(s) });
  } catch (e) {
    return { ok: false, error: errorText(e), count: 0, items: [], request_url: "" };
  }
}

/** One editable source (type-specific fields + Test). */
export function SourceEditor({
  value,
  onChange,
  onRemove,
  removeLabel = "Remove",
}: {
  value: SourceDraft;
  onChange: (s: SourceDraft) => void;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const k = value.key;
  const set = (patch: Partial<SourceDraft>) => {
    setResult(null);
    onChange({ ...value, ...patch });
  };
  const setParam = (patch: Partial<SourceDraft["params"]>) => set({ params: { ...value.params, ...patch } });

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <div>
          <label htmlFor={`${k}-type`} className={labelClass}>
            Type
          </label>
          <select
            id={`${k}-type`}
            className={`${inputClass} mt-1`}
            value={value.type}
            onChange={(e) => {
              const type = e.target.value as ApSourceType;
              set({
                type,
                params: type === "google_news" ? { hl: value.params.hl || "en", gl: value.params.gl || "BD" } : type === "gdelt" ? { timespan: "1d" } : {},
              });
            }}
          >
            {(Object.keys(SOURCE_TYPE_LABEL) as ApSourceType[]).map((t) => (
              <option key={t} value={t}>
                {SOURCE_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        {value.type === "rss" ? (
          <div>
            <label htmlFor={`${k}-url`} className={labelClass}>
              Feed URL
            </label>
            <input
              id={`${k}-url`}
              type="url"
              inputMode="url"
              placeholder="https://… (the outlet's RSS or Atom feed)"
              className={`${inputClass} mt-1`}
              value={value.url}
              onChange={(e) => set({ url: e.target.value })}
            />
          </div>
        ) : (
          <div>
            <label htmlFor={`${k}-q`} className={labelClass}>
              {value.type === "gdelt" ? "GDELT query" : "Search query"}
            </label>
            <input
              id={`${k}-q`}
              className={`${inputClass} mt-1`}
              placeholder={value.type === "gdelt" ? "technology sourcecountry:bangladesh" : "Bangladesh technology"}
              value={value.query}
              onChange={(e) => set({ query: e.target.value })}
            />
            {value.type === "gdelt" && (
              <p className={hintClass}>
                Operators work inside the query, e.g. <code>sourcecountry:bangladesh</code>, <code>sourcelang:bengali</code>, <code>domain:example.com</code>.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <label htmlFor={`${k}-label`} className={labelClass}>
            Label <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <input id={`${k}-label`} className={`${inputClass} mt-1`} value={value.label} maxLength={200} onChange={(e) => set({ label: e.target.value })} />
        </div>
        {value.type === "google_news" && (
          <>
            <div>
              <label htmlFor={`${k}-hl`} className={labelClass}>
                Language (hl)
              </label>
              <input id={`${k}-hl`} className={`${inputClass} mt-1`} value={value.params.hl ?? ""} placeholder="en / bn" onChange={(e) => setParam({ hl: e.target.value })} />
            </div>
            <div>
              <label htmlFor={`${k}-gl`} className={labelClass}>
                Country (gl)
              </label>
              <input id={`${k}-gl`} className={`${inputClass} mt-1`} value={value.params.gl ?? ""} placeholder="BD" onChange={(e) => setParam({ gl: e.target.value })} />
            </div>
          </>
        )}
        {value.type === "gdelt" && (
          <div>
            <label htmlFor={`${k}-ts`} className={labelClass}>
              Time span
            </label>
            <select id={`${k}-ts`} className={`${inputClass} mt-1`} value={value.params.timespan ?? "1d"} onChange={(e) => setParam({ timespan: e.target.value })}>
              {["6h", "12h", "1d", "2d", "3d"].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={testing}
          onClick={async () => {
            setTesting(true);
            setResult(await testSource(value));
            setTesting(false);
          }}
        >
          Test
        </Button>
        {onRemove && (
          <Button variant="ghost" size="sm" onClick={onRemove} className="text-red-700">
            {removeLabel}
          </Button>
        )}
      </div>
      {result && <SourceTestResult result={result} />}
    </div>
  );
}
