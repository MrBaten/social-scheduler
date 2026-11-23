"use client";

import { useRef } from "react";
import type { ApPlatform } from "@/lib/autopilot/types";
import { TEMPLATE_VARS, hintClass, inputClass, labelClass } from "./shared";

export interface TemplateDraft {
  key: string;
  id?: string;
  name: string;
  platform: ApPlatform | "all";
  structure: string;
  tone_notes: string;
  hashtag_rules: string;
  enabled: boolean;
}

export function defaultTemplate(key: string, language: "bn" | "en" | "both"): TemplateDraft {
  return {
    key,
    name: "News brief",
    platform: "all",
    structure: `{headline}\n\n{summary}\n\n${language === "bn" ? "সূত্র" : "Source"}: {source}\n{link}`,
    tone_notes: "Clear, neutral and informative. No clickbait.",
    hashtag_rules: "2–3 relevant hashtags at the end; up to 5 on Instagram.",
    enabled: true,
  };
}

export function templatePayload(t: TemplateDraft) {
  return {
    name: t.name.trim(),
    platform: t.platform,
    structure: t.structure,
    tone_notes: t.tone_notes,
    hashtag_rules: t.hashtag_rules,
    enabled: t.enabled,
  };
}

const PLATFORM_OPTIONS: { v: TemplateDraft["platform"]; l: string }[] = [
  { v: "all", l: "All platforms" },
  { v: "facebook", l: "Facebook" },
  { v: "instagram", l: "Instagram" },
  { v: "linkedin", l: "LinkedIn" },
];

/** Template editor fields with variable chips that insert at the cursor. */
export function TemplateFields({ value, onChange }: { value: TemplateDraft; onChange: (t: TemplateDraft) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const k = value.key;
  const set = (patch: Partial<TemplateDraft>) => onChange({ ...value, ...patch });

  function insert(token: string) {
    const el = ref.current;
    if (!el) {
      set({ structure: value.structure + token });
      return;
    }
    const start = el.selectionStart ?? value.structure.length;
    const end = el.selectionEnd ?? start;
    const next = value.structure.slice(0, start) + token + value.structure.slice(end);
    set({ structure: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <div>
          <label htmlFor={`${k}-name`} className={labelClass}>
            Template name
          </label>
          <input id={`${k}-name`} className={`${inputClass} mt-1`} value={value.name} maxLength={100} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div>
          <label htmlFor={`${k}-platform`} className={labelClass}>
            Used for
          </label>
          <select
            id={`${k}-platform`}
            className={`${inputClass} mt-1`}
            value={value.platform}
            onChange={(e) => set({ platform: e.target.value as TemplateDraft["platform"] })}
          >
            {PLATFORM_OPTIONS.map((o) => (
              <option key={o.v} value={o.v}>
                {o.l}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor={`${k}-structure`} className={labelClass}>
          Structure
        </label>
        <div className="mt-1 flex flex-wrap gap-1.5" aria-label="Insert variable">
          {TEMPLATE_VARS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => insert(t)}
              className="rounded-md border border-violet-200 bg-violet-50 px-2 py-0.5 font-mono text-xs text-violet-800 hover:bg-violet-100"
            >
              {t}
            </button>
          ))}
        </div>
        <textarea
          id={`${k}-structure`}
          ref={ref}
          rows={6}
          className={`${inputClass} mt-2 font-mono`}
          value={value.structure}
          maxLength={4000}
          onChange={(e) => set({ structure: e.target.value })}
        />
        <p className={hintClass}>
          With AI on, the model rewrites the story in its own words following this shape. Without AI, the variables are filled directly. The source credit and
          link are always added if missing.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${k}-tone`} className={labelClass}>
            Tone notes
          </label>
          <textarea id={`${k}-tone`} rows={2} className={`${inputClass} mt-1`} value={value.tone_notes} maxLength={1000} onChange={(e) => set({ tone_notes: e.target.value })} />
        </div>
        <div>
          <label htmlFor={`${k}-tags`} className={labelClass}>
            Hashtag rules
          </label>
          <textarea id={`${k}-tags`} rows={2} className={`${inputClass} mt-1`} value={value.hashtag_rules} maxLength={500} onChange={(e) => set({ hashtag_rules: e.target.value })} />
        </div>
      </div>
      <label className="inline-flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" className="h-4 w-4 rounded border-gray-300" checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        Enabled (templates rotate so posts don&apos;t all look the same)
      </label>
    </div>
  );
}
