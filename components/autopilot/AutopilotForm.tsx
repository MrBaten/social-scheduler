"use client";

import { useEffect, useState } from "react";
import type { ApLanguage, Autopilot } from "@/lib/autopilot/types";
import type { SocialAccountPublic } from "@/lib/types";
import { api } from "../api";
import { Spinner } from "../Button";
import { Alert, DemoBadge } from "../Card";
import { PlatformIcon } from "../PlatformBadge";
import { AP_PLATFORM_LIST, LANGUAGE_LABEL, hintClass, inputClass, labelClass } from "./shared";
import { TagInput } from "./TagInput";

/** Fields of an autopilot edited in the wizard (steps 1, 4, 5) and on Settings. */
export interface AutopilotFormValues {
  name: string;
  niche_description: string;
  keywords: string[];
  region_terms: string[];
  banned_terms: string[];
  language: ApLanguage;
  timezone: string;
  account_ids: string[];
  frequency_minutes: number;
  window_start: string;
  window_end: string;
  daily_cap: number;
  min_gap_minutes: number;
  ai_daily_cap: number;
  max_age_hours: number;
  min_score: number;
}

export const EXAMPLE_VALUES: AutopilotFormValues = {
  name: "Bangladesh tech news",
  niche_description: "Technology, startups and digital services in Bangladesh, for a general audience.",
  keywords: ["technology", "startup", "fintech", "mobile", "internet", "AI", "প্রযুক্তি"],
  region_terms: ["Bangladesh", "Dhaka", "বাংলাদেশ", "ঢাকা"],
  banned_terms: [],
  language: "en",
  timezone: "Asia/Dhaka",
  account_ids: [],
  frequency_minutes: 120,
  window_start: "08:00",
  window_end: "23:00",
  daily_cap: 12,
  min_gap_minutes: 60,
  ai_daily_cap: 200,
  max_age_hours: 48,
  min_score: 30,
};

export function valuesFromAutopilot(a: Autopilot): AutopilotFormValues {
  return {
    name: a.name,
    niche_description: a.niche_description,
    keywords: a.keywords,
    region_terms: a.region_terms,
    banned_terms: a.banned_terms,
    language: a.language,
    timezone: a.timezone,
    account_ids: a.account_ids,
    frequency_minutes: a.frequency_minutes,
    window_start: a.window_start,
    window_end: a.window_end,
    daily_cap: a.daily_cap,
    min_gap_minutes: a.min_gap_minutes,
    ai_daily_cap: a.ai_daily_cap,
    max_age_hours: a.max_age_hours,
    min_score: a.min_score,
  };
}

type SetFn = <K extends keyof AutopilotFormValues>(k: K, v: AutopilotFormValues[K]) => void;

const TIMEZONES = ["Asia/Dhaka", "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "UTC"];

export function ProfileFields({ v, set }: { v: AutopilotFormValues; set: SetFn }) {
  const tzOptions = TIMEZONES.includes(v.timezone) ? TIMEZONES : [v.timezone, ...TIMEZONES];
  return (
    <div className="space-y-5">
      <div>
        <label htmlFor="ap-name" className={labelClass}>
          Name
        </label>
        <input id="ap-name" className={`${inputClass} mt-1`} value={v.name} maxLength={100} onChange={(e) => set("name", e.target.value)} />
      </div>
      <div>
        <label htmlFor="ap-desc" className={labelClass}>
          Niche and audience
        </label>
        <textarea
          id="ap-desc"
          rows={2}
          className={`${inputClass} mt-1`}
          value={v.niche_description}
          maxLength={1000}
          onChange={(e) => set("niche_description", e.target.value)}
        />
        <p className={hintClass}>One or two sentences. The AI uses this to judge tone and relevance.</p>
      </div>
      <TagInput
        label="Keywords"
        value={v.keywords}
        onChange={(x) => set("keywords", x)}
        placeholder="technology, startup, প্রযুক্তি…"
        hint="A story must match at least one keyword. Matches in the headline count double. Bangla and English both work."
      />
      <TagInput
        label="Region terms"
        value={v.region_terms}
        onChange={(x) => set("region_terms", x)}
        placeholder="Bangladesh, Dhaka, বাংলাদেশ…"
        hint="Stories that mention one of these score higher."
      />
      <TagInput
        label="Banned words and topics"
        tone="red"
        value={v.banned_terms}
        onChange={(x) => set("banned_terms", x)}
        placeholder="e.g. betting, gossip"
        hint="Any story containing one of these is archived, never drafted."
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <fieldset>
          <legend className={labelClass}>Language</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {(["bn", "en", "both"] as ApLanguage[]).map((l) => (
              <label
                key={l}
                className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm ${
                  v.language === l ? "border-indigo-400 bg-indigo-50 text-indigo-800" : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                }`}
              >
                <input type="radio" name="ap-language" className="sr-only" checked={v.language === l} onChange={() => set("language", l)} />
                {LANGUAGE_LABEL[l]}
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <label htmlFor="ap-tz" className={labelClass}>
            Time zone
          </label>
          <select id="ap-tz" className={`${inputClass} mt-1`} value={v.timezone} onChange={(e) => set("timezone", e.target.value)}>
            {tzOptions.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
          <p className={hintClass}>Posting window and daily counts use this time zone.</p>
        </div>
      </div>
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  hint,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  hint?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        className={`${inputClass} mt-1`}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
      />
      {hint && <p className={hintClass}>{hint}</p>}
    </div>
  );
}

export function AccountsField({ v, set }: { v: AutopilotFormValues; set: SetFn }) {
  const [accounts, setAccounts] = useState<SocialAccountPublic[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ accounts: SocialAccountPublic[] }>("/api/accounts")
      .then((r) => setAccounts((r.accounts ?? []).filter((a) => (AP_PLATFORM_LIST as string[]).includes(a.platform))))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "Could not load accounts"));
  }, []);

  const toggle = (id: string) => set("account_ids", v.account_ids.includes(id) ? v.account_ids.filter((x) => x !== id) : [...v.account_ids, id]);

  return (
    <fieldset>
      <legend className={labelClass}>Accounts to post to</legend>
      <p className={hintClass}>Facebook, Instagram and LinkedIn only. Approved drafts become posts for these accounts.</p>
      {err && <Alert tone="error" className="mt-2">{err}</Alert>}
      {accounts === null && !err ? (
        <p className="mt-2 flex items-center gap-2 text-sm text-gray-500">
          <Spinner /> Loading accounts…
        </p>
      ) : accounts && accounts.length === 0 ? (
        <Alert tone="warning" className="mt-2">
          No Facebook, Instagram or LinkedIn accounts connected yet. <a href="/accounts" className="font-medium underline">Connect them</a> first. You can still create the autopilot and add accounts later in Settings.
        </Alert>
      ) : (
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {(accounts ?? []).map((a) => (
            <li key={a.id}>
              <label
                className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm ${
                  v.account_ids.includes(a.id) ? "border-indigo-400 bg-indigo-50" : "border-gray-200 bg-white hover:bg-gray-50"
                }`}
              >
                <input type="checkbox" className="h-4 w-4 rounded border-gray-300" checked={v.account_ids.includes(a.id)} onChange={() => toggle(a.id)} />
                <PlatformIcon platform={a.platform} size="sm" />
                <span className="min-w-0 flex-1 truncate font-medium text-gray-800">{a.display_name}</span>
                {a.is_demo && <DemoBadge />}
                {a.status === "expired" && (
                  <span className="rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">Expired</span>
                )}
              </label>
            </li>
          ))}
        </ul>
      )}
      {accounts?.some((a) => v.account_ids.includes(a.id) && a.platform === "instagram") && (
        <p className="mt-2 text-xs text-amber-700">
          Instagram needs an image: attach one to the draft when you approve it (branded image cards come in Phase 2).
        </p>
      )}
    </fieldset>
  );
}

export function ScheduleFields({ v, set }: { v: AutopilotFormValues; set: SetFn }) {
  return (
    <div className="space-y-5">
      <AccountsField v={v} set={set} />
      <div className="grid gap-5 sm:grid-cols-3">
        <div>
          <label htmlFor="ap-freq" className={labelClass}>
            Post every
          </label>
          <select id="ap-freq" className={`${inputClass} mt-1`} value={v.frequency_minutes} onChange={(e) => set("frequency_minutes", Number(e.target.value))}>
            {[60, 90, 120, 180, 240, 360].map((m) => (
              <option key={m} value={m}>
                {m % 60 === 0 ? `${m / 60} hour${m === 60 ? "" : "s"}` : `${m / 60} hours`}
              </option>
            ))}
            {![60, 90, 120, 180, 240, 360].includes(v.frequency_minutes) && <option value={v.frequency_minutes}>{v.frequency_minutes} min</option>}
          </select>
        </div>
        <div>
          <label htmlFor="ap-ws" className={labelClass}>
            Window starts
          </label>
          <input id="ap-ws" type="time" className={`${inputClass} mt-1`} value={v.window_start} onChange={(e) => set("window_start", e.target.value)} />
        </div>
        <div>
          <label htmlFor="ap-we" className={labelClass}>
            Window ends
          </label>
          <input id="ap-we" type="time" className={`${inputClass} mt-1`} value={v.window_end} onChange={(e) => set("window_end", e.target.value)} />
        </div>
      </div>
      <p className="-mt-2 text-xs text-gray-500">
        A draft is written about 20 minutes before each posting slot, so it&apos;s fresh when you review it.
      </p>
      <div className="grid gap-5 sm:grid-cols-3">
        <NumberField id="ap-cap" label="Posts per day" value={v.daily_cap} min={1} max={48} onChange={(n) => set("daily_cap", n)} />
        <NumberField id="ap-gap" label="Minimum gap (minutes)" value={v.min_gap_minutes} min={0} max={1440} onChange={(n) => set("min_gap_minutes", n)} />
        <NumberField
          id="ap-ai"
          label="AI calls per day"
          value={v.ai_daily_cap}
          min={0}
          max={5000}
          onChange={(n) => set("ai_daily_cap", n)}
          hint="Cost cap. The autopilot pauses when it's reached."
        />
        <NumberField
          id="ap-age"
          label="Ignore stories older than (hours)"
          value={v.max_age_hours}
          min={1}
          max={720}
          onChange={(n) => set("max_age_hours", n)}
        />
        <NumberField
          id="ap-min"
          label="Minimum relevance score"
          value={v.min_score}
          min={0}
          max={100}
          onChange={(n) => set("min_score", n)}
          hint="0–100. Lower stories are archived, not deleted."
        />
      </div>
    </div>
  );
}

export function ApprovalFields() {
  const modes = [
    { id: "manual", title: "Manual", body: "Every draft goes to your Review inbox. Nothing posts until you approve it.", enabled: true },
    { id: "assisted", title: "Assisted", body: "High-scoring drafts schedule themselves; the rest go to the inbox.", enabled: false },
    { id: "full_auto", title: "Full auto", body: "Everything that passes the checks publishes; sensitive topics still go to you.", enabled: false },
  ];
  return (
    <fieldset>
      <legend className={labelClass}>Approval mode</legend>
      <div className="mt-2 grid gap-3 sm:grid-cols-3">
        {modes.map((m) => (
          <label
            key={m.id}
            className={`rounded-xl border p-4 text-sm ${
              m.enabled ? "cursor-pointer border-indigo-400 bg-indigo-50" : "cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400"
            }`}
          >
            <span className="flex items-center gap-2">
              <input type="radio" name="ap-approval" checked={m.enabled} disabled={!m.enabled} readOnly className="h-4 w-4" />
              <span className={`font-semibold ${m.enabled ? "text-gray-900" : ""}`}>{m.title}</span>
              {!m.enabled && <span className="ml-auto rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-semibold text-gray-600">Phase 3</span>}
            </span>
            <span className="mt-2 block">{m.body}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Body for POST/PATCH; NaN numbers dropped so the server applies its default / keeps the value. */
export function autopilotPayload(v: AutopilotFormValues) {
  const num = (n: number) => (Number.isFinite(n) ? Math.round(n) : undefined);
  return {
    name: v.name.trim(),
    niche_description: v.niche_description.trim(),
    keywords: v.keywords,
    region_terms: v.region_terms,
    banned_terms: v.banned_terms,
    language: v.language,
    timezone: v.timezone,
    account_ids: v.account_ids,
    frequency_minutes: num(v.frequency_minutes),
    window_start: v.window_start,
    window_end: v.window_end,
    daily_cap: num(v.daily_cap),
    min_gap_minutes: num(v.min_gap_minutes),
    ai_daily_cap: num(v.ai_daily_cap),
    max_age_hours: num(v.max_age_hours),
    min_score: num(v.min_score),
    approval_mode: "manual" as const,
  };
}
