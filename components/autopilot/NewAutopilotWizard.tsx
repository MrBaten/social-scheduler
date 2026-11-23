"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Autopilot } from "@/lib/autopilot/types";
import { api } from "../api";
import { Button } from "../Button";
import { Alert, Card } from "../Card";
import {
  ApprovalFields,
  EXAMPLE_VALUES,
  ProfileFields,
  ScheduleFields,
  autopilotPayload,
  type AutopilotFormValues,
} from "./AutopilotForm";
import { SourceEditor } from "./SourceEditor";
import { TemplateFields, defaultTemplate, templatePayload, type TemplateDraft } from "./TemplateFields";
import { LANGUAGE_LABEL, SOURCE_TYPE_LABEL, emptySource, errorText, newKey, sourcePayload, type SourceDraft } from "./shared";

const STEPS = ["Niche profile", "Sources", "Templates", "Accounts & schedule", "Approval & review"];

function suggestedSources(v: AutopilotFormValues): SourceDraft[] {
  const region = v.region_terms.find((t) => /^[\x20-\x7e]+$/.test(t)) ?? "Bangladesh";
  const enKeyword = v.keywords.find((t) => /^[\x20-\x7e]+$/.test(t)) ?? "technology";
  const out: SourceDraft[] = [];
  if (v.language !== "bn") {
    out.push({ ...emptySource("google_news", "en"), label: "Google News (English)", query: `${region} ${enKeyword}` });
  }
  if (v.language !== "en") {
    const bnRegion = v.region_terms.find((t) => /[ঀ-৿]/.test(t)) ?? "বাংলাদেশ";
    const bnKeyword = v.keywords.find((t) => /[ঀ-৿]/.test(t)) ?? "প্রযুক্তি";
    out.push({ ...emptySource("google_news", "bn"), label: "Google News (Bangla)", query: `${bnKeyword} ${bnRegion}` });
  }
  out.push({
    ...emptySource("gdelt"),
    label: "GDELT",
    query: `${enKeyword} sourcecountry:${region.toLowerCase().replace(/\s+/g, "")}`,
  });
  return out;
}

export function NewAutopilotWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [v, setV] = useState<AutopilotFormValues>(EXAMPLE_VALUES);
  const [sources, setSources] = useState<SourceDraft[] | null>(null);
  const [templates, setTemplates] = useState<TemplateDraft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof AutopilotFormValues>(k: K, val: AutopilotFormValues[K]) => setV((prev) => ({ ...prev, [k]: val }));

  function validate(s: number): string | null {
    if (s === 0) {
      if (!v.name.trim()) return "Give the autopilot a name.";
      if (!v.keywords.length) return "Add at least one keyword.";
    }
    if (s === 1) {
      const list = sources ?? [];
      if (!list.length) return "Add at least one source.";
      const bad = list.find((x) => (x.type === "rss" ? !/^https?:\/\//i.test(x.url.trim()) : x.query.trim().length < (x.type === "gdelt" ? 3 : 1)));
      if (bad) return `Fill in the ${bad.type === "rss" ? "feed URL" : "query"} of every source (or remove the empty one).`;
    }
    if (s === 2) {
      const list = templates ?? [];
      if (!list.length) return "Keep at least one template.";
      if (list.some((t) => !t.name.trim() || !t.structure.trim())) return "Every template needs a name and a structure.";
    }
    if (s === 3) {
      if (v.window_start >= v.window_end) return "The posting window must end after it starts.";
      for (const [k, label] of [
        ["daily_cap", "Posts per day"],
        ["min_gap_minutes", "Minimum gap"],
        ["ai_daily_cap", "AI calls per day"],
        ["max_age_hours", "Story age"],
        ["min_score", "Minimum score"],
      ] as const) {
        if (!Number.isFinite(v[k])) return `${label} must be a number.`;
      }
    }
    return null;
  }

  function goTo(next: number) {
    if (next > step) {
      for (let s = step; s < next; s++) {
        const err = validate(s);
        if (err) {
          setError(err);
          return;
        }
      }
    }
    setError(null);
    if (next === 1 && sources === null) setSources(suggestedSources(v));
    if (next === 2 && templates === null) setTemplates([defaultTemplate(newKey(), v.language)]);
    setStep(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function create() {
    for (let s = 0; s < 4; s++) {
      const err = validate(s);
      if (err) {
        setError(err);
        setStep(s);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ autopilot: Autopilot }>("/api/autopilot", {
        method: "POST",
        json: {
          ...autopilotPayload(v),
          sources: (sources ?? []).map(sourcePayload),
          templates: (templates ?? []).map(templatePayload),
        },
      });
      router.push(`/autopilot/${r.autopilot.id}/inbox?created=1`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <div>
      <ol className="mb-6 grid grid-cols-5 gap-2" aria-label="Setup steps">
        {STEPS.map((label, i) => (
          <li key={label}>
            <button
              type="button"
              onClick={() => goTo(i)}
              aria-current={i === step ? "step" : undefined}
              className={`flex w-full flex-col items-start rounded-lg border px-2 py-2 text-left text-xs transition-colors sm:px-3 ${
                i === step
                  ? "border-violet-400 bg-violet-50 text-violet-900"
                  : i < step
                    ? "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                    : "border-gray-200 bg-white text-gray-400 hover:bg-gray-50"
              }`}
            >
              <span className="font-semibold">{i + 1}</span>
              <span className="hidden sm:block">{label}</span>
            </button>
          </li>
        ))}
      </ol>

      {error && (
        <Alert tone="error" className="mb-4">
          {error}
        </Alert>
      )}

      {step === 0 && (
        <Card title="1. Niche profile" description="What this autopilot watches for. The example is filled in. Edit it to your niche.">
          <ProfileFields v={v} set={set} />
        </Card>
      )}

      {step === 1 && (
        <Card
          title="2. Sources"
          description="Free sources only: RSS feeds, Google News searches and GDELT. Each source is checked every 15 minutes."
        >
          <Alert tone="info" className="mb-4">
            We suggested a few searches from your profile. Add the RSS feeds of outlets you trust (most news sites publish one, often at /feed or /rss), and press{" "}
            <strong>Test</strong> on each source before continuing.
          </Alert>
          <div className="space-y-3">
            {(sources ?? []).map((s, i) => (
              <SourceEditor
                key={s.key}
                value={s}
                onChange={(next) => setSources((prev) => (prev ?? []).map((x, j) => (j === i ? next : x)))}
                onRemove={() => setSources((prev) => (prev ?? []).filter((_, j) => j !== i))}
              />
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {(["rss", "google_news", "gdelt"] as const).map((t) => (
              <Button key={t} variant="secondary" size="sm" onClick={() => setSources((prev) => [...(prev ?? []), emptySource(t, v.language)])}>
                + {SOURCE_TYPE_LABEL[t]}
              </Button>
            ))}
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card title="3. Templates" description="How posts are shaped. Add platform-specific templates if Facebook, Instagram and LinkedIn should differ.">
          <div className="space-y-4">
            {(templates ?? []).map((t, i) => (
              <div key={t.key} className="rounded-xl border border-gray-200 p-4">
                <TemplateFields value={t} onChange={(next) => setTemplates((prev) => (prev ?? []).map((x, j) => (j === i ? next : x)))} />
                {(templates ?? []).length > 1 && (
                  <Button variant="ghost" size="sm" className="mt-3 text-red-700" onClick={() => setTemplates((prev) => (prev ?? []).filter((_, j) => j !== i))}>
                    Remove template
                  </Button>
                )}
              </div>
            ))}
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="mt-4"
            onClick={() => setTemplates((prev) => [...(prev ?? []), { ...defaultTemplate(newKey(), v.language), name: "Another template" }])}
          >
            + Add template
          </Button>
          <p className="mt-3 text-xs text-gray-500">Image card design comes in Phase 2.</p>
        </Card>
      )}

      {step === 3 && (
        <Card title="4. Accounts, frequency and posting window" description={`Times are in ${v.timezone}.`}>
          <ScheduleFields v={v} set={set} />
        </Card>
      )}

      {step === 4 && (
        <Card title="5. Approval mode and review">
          <ApprovalFields />
          <dl className="mt-6 grid gap-x-6 gap-y-2 rounded-xl bg-gray-50 p-4 text-sm sm:grid-cols-2">
            <Summary label="Name" value={v.name} />
            <Summary label="Language" value={LANGUAGE_LABEL[v.language]} />
            <Summary label="Keywords" value={v.keywords.join(", ") || "—"} />
            <Summary label="Region" value={v.region_terms.join(", ") || "—"} />
            <Summary label="Banned" value={v.banned_terms.join(", ") || "—"} />
            <Summary label="Sources" value={`${(sources ?? []).length}`} />
            <Summary label="Templates" value={`${(templates ?? []).length}`} />
            <Summary label="Accounts" value={`${v.account_ids.length}`} />
            <Summary
              label="Schedule"
              value={`every ${v.frequency_minutes} min, ${v.window_start}–${v.window_end}, max ${v.daily_cap}/day, gap ${v.min_gap_minutes} min`}
            />
            <Summary label="AI calls per day" value={`${v.ai_daily_cap}`} />
          </dl>
          <p className="mt-4 text-sm text-gray-600">
            After creating, drafts appear in the Review inbox. Approving one puts a normal post in your Queue. Nothing publishes without your approval.
          </p>
        </Card>
      )}

      <div className="mt-6 flex items-center justify-between gap-3">
        <Button variant="secondary" onClick={() => goTo(step - 1)} disabled={step === 0 || busy}>
          Back
        </Button>
        {step < STEPS.length - 1 ? (
          <Button onClick={() => goTo(step + 1)}>Next: {STEPS[step + 1]}</Button>
        ) : (
          <Button onClick={create} loading={busy}>
            Create autopilot
          </Button>
        )}
      </div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-32 shrink-0 text-gray-500">{label}</dt>
      <dd className="min-w-0 break-words font-medium text-gray-900">{value}</dd>
    </div>
  );
}
