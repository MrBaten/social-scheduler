"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { AutopilotSummary } from "@/lib/autopilot/types";
import { api, formatLocal } from "../api";
import { Alert } from "../Card";
import { ApStatus } from "./OverviewView";
import { errorText } from "./shared";

const TABS = [
  { seg: "inbox", label: "Inbox" },
  { seg: "sources", label: "Sources" },
  { seg: "templates", label: "Templates" },
  { seg: "activity", label: "Activity" },
  { seg: "settings", label: "Settings" },
];

export function AutopilotHeader({ id }: { id: string }) {
  const pathname = usePathname() ?? "";
  const [ap, setAp] = useState<AutopilotSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ autopilot: AutopilotSummary }>(`/api/autopilot/${id}`)
        .then((r) => alive && (setAp(r.autopilot), setError(null)))
        .catch((e: unknown) => alive && setError(errorText(e)));
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, pathname]);

  return (
    <div className="mb-6">
      <Link href="/autopilot" className="text-sm text-gray-500 hover:text-gray-800">
        ← All autopilots
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">{ap?.name ?? (error ? "Autopilot" : "Loading…")}</h1>
        {ap && <ApStatus status={ap.status} />}
        {ap && ap.today.inbox > 0 && (
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-800">{ap.today.inbox} to review</span>
        )}
      </div>
      {ap && (
        <p className="mt-1 text-sm text-gray-500">
          Next slot {ap.next_slot_at ? formatLocal(ap.next_slot_at) : "—"} · today: {ap.today.found} found, {ap.today.drafted} drafted, {ap.today.approved} approved,{" "}
          {ap.today.published} published
        </p>
      )}
      {ap?.status === "paused" && ap.paused_reason && (
        <Alert tone="warning" className="mt-3">
          Paused: {ap.paused_reason}
        </Alert>
      )}
      {ap && ap.expired_accounts.length > 0 && (
        <Alert tone="warning" className="mt-3">
          Account expired: {ap.expired_accounts.join(", ")}.{" "}
          <Link href="/accounts" className="font-medium underline">
            Reconnect
          </Link>
        </Alert>
      )}
      {error && (
        <Alert tone="error" className="mt-3">
          {error}
        </Alert>
      )}
      <nav className="mt-4 flex gap-1 overflow-x-auto border-b border-gray-200" aria-label="Autopilot sections">
        {TABS.map((t) => {
          const href = `/autopilot/${id}/${t.seg}`;
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={t.seg}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
                active ? "border-violet-600 text-violet-700" : "border-transparent text-gray-600 hover:border-gray-300 hover:text-gray-900"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
