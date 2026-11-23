"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { hintClass, labelClass } from "./shared";

/** Chip input: type and press Enter or comma; Backspace on empty removes the last chip. */
export function TagInput({
  label,
  value,
  onChange,
  placeholder,
  hint,
  tone = "indigo",
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  hint?: string;
  tone?: "indigo" | "red";
}) {
  const id = useId();
  const [draft, setDraft] = useState("");

  function add(raw: string) {
    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const p of parts) if (!next.some((x) => x.toLowerCase() === p.toLowerCase())) next.push(p.slice(0, 100));
    onChange(next);
    setDraft("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  }

  const chip = tone === "red" ? "bg-red-50 text-red-800 border-red-200" : "bg-indigo-50 text-indigo-800 border-indigo-200";

  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <div className="mt-1 flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2 py-1.5 shadow-sm focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/30">
        {value.map((t, i) => (
          <span key={`${t}-${i}`} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${chip}`}>
            {t}
            <button
              type="button"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              className="rounded-full px-0.5 leading-none opacity-60 hover:opacity-100"
              aria-label={`Remove ${t}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={id}
          value={draft}
          onChange={(e) => {
            const v = e.target.value;
            if (v.includes(",")) add(v);
            else setDraft(v);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => add(draft)}
          placeholder={value.length ? "" : placeholder}
          className="min-w-32 flex-1 border-0 bg-transparent p-1 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none"
        />
      </div>
      {hint && <p className={hintClass}>{hint}</p>}
    </div>
  );
}
