"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PostWithTargets } from "@/lib/types";
import { api } from "./api";
import { Button, buttonClasses, Spinner } from "./Button";
import { Alert, Card } from "./Card";
import { PlatformBadge } from "./PlatformBadge";
import { StatusPill } from "./StatusPill";

const REFRESH_MS = 10_000;

/** Monday 00:00 local time of the week containing `d`. */
function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // Mon=0
  x.setDate(x.getDate() - dow);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n); // DST-safe (local calendar arithmetic)
  return x;
}

function sameLocalDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function snippet(p: PostWithTargets) {
  const t = p.base_text.trim() || p.targets.find((x) => x.text_override?.trim())?.text_override?.trim() || "";
  return t || (p.media.length ? `${p.media.length} media item${p.media.length === 1 ? "" : "s"}` : "(no text)");
}

function sortByTime(a: PostWithTargets, b: PostWithTargets) {
  return (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? "");
}

export function QueueView() {
  const [view, setView] = useState<"week" | "list">("week");
  const [weekStart, setWeekStart] = useState<Date | null>(null);
  const [posts, setPosts] = useState<PostWithTargets[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);

  // Compute "this week" only on the client to avoid server/client time-zone mismatch.
  useEffect(() => {
    setWeekStart(startOfWeek(new Date()));
  }, []);

  const load = useCallback(async () => {
    if (view === "week" && !weekStart) return;
    const mySeq = ++seq.current;
    setRefreshing(true);
    try {
      let url = "/api/posts";
      if (view === "week" && weekStart) {
        const from = weekStart.toISOString();
        const to = addDays(weekStart, 7).toISOString();
        url += `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      }
      const r = await api<{ posts: PostWithTargets[] }>(url);
      if (mySeq !== seq.current) return;
      setPosts(r.posts ?? []);
      setError(null);
    } catch (e) {
      if (mySeq !== seq.current) return;
      setError(e instanceof Error ? e.message : "Could not load posts");
    } finally {
      if (mySeq === seq.current) setRefreshing(false);
    }
  }, [view, weekStart]);

  useEffect(() => {
    setPosts(null);
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const days = useMemo(() => (weekStart ? Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)) : []), [weekStart]);

  const rangeLabel = useMemo(() => {
    if (!weekStart) return "";
    const end = addDays(weekStart, 6);
    const sameMonth = weekStart.getMonth() === end.getMonth();
    const startStr = weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const endStr = end.toLocaleDateString(undefined, sameMonth ? { day: "numeric", year: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
    return `${startStr} – ${endStr}`;
  }, [weekStart]);

  const isThisWeek = weekStart ? sameLocalDay(weekStart, startOfWeek(new Date())) : true;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg bg-gray-100 p-1" role="tablist" aria-label="View">
          {(["week", "list"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              type="button"
              onClick={() => setView(v)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
                view === v ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"
              }`}
            >
              {v === "week" ? "Week" : "List"}
            </button>
          ))}
        </div>

        {view === "week" && weekStart && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="Previous week">
              ‹ Prev
            </Button>
            {!isThisWeek && (
              <Button variant="ghost" size="sm" onClick={() => setWeekStart(startOfWeek(new Date()))}>
                Today
              </Button>
            )}
            <span className="min-w-36 text-center text-sm font-medium text-gray-800">{rangeLabel}</span>
            <Button variant="secondary" size="sm" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="Next week">
              Next ›
            </Button>
          </div>
        )}

        <span className="flex items-center gap-1.5 text-xs text-gray-400">
          {refreshing ? <Spinner className="h-3 w-3" /> : <span className="h-1.5 w-1.5 rounded-full bg-green-500" aria-hidden="true" />}
          Auto-refresh every 10s
        </span>
      </div>

      {error && (
        <Alert tone="error" className="mb-4">
          {error}
        </Alert>
      )}

      {posts === null ? (
        <div className="flex items-center gap-2 py-10 text-sm text-gray-500">
          <Spinner /> Loading posts…
        </div>
      ) : view === "week" ? (
        <WeekGrid days={days} posts={posts} />
      ) : (
        <ListView posts={posts} />
      )}
    </div>
  );
}

function WeekGrid({ days, posts }: { days: Date[]; posts: PostWithTargets[] }) {
  const today = new Date();
  const scheduled = posts.filter((p) => p.scheduled_at).sort(sortByTime);
  const total = scheduled.filter((p) => days.some((d) => sameLocalDay(new Date(p.scheduled_at!), d))).length;

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-7">
        {days.map((day) => {
          const items = scheduled.filter((p) => sameLocalDay(new Date(p.scheduled_at!), day));
          const isToday = sameLocalDay(day, today);
          return (
            <div
              key={day.toISOString()}
              className={`flex min-h-40 flex-col rounded-xl border bg-white ${isToday ? "border-indigo-300 ring-1 ring-indigo-200" : "border-gray-200"}`}
            >
              <div className={`flex items-baseline justify-between border-b px-3 py-2 ${isToday ? "border-indigo-100 bg-indigo-50/60" : "border-gray-100"}`}>
                <span className={`text-xs font-semibold uppercase tracking-wide ${isToday ? "text-indigo-700" : "text-gray-500"}`}>
                  {day.toLocaleDateString(undefined, { weekday: "short" })}
                </span>
                <span className={`text-sm font-semibold ${isToday ? "text-indigo-700" : "text-gray-800"}`}>{day.getDate()}</span>
              </div>
              <div className="flex flex-1 flex-col gap-2 p-2">
                {items.length === 0 ? (
                  <span className="m-auto text-xs text-gray-300">No posts</span>
                ) : (
                  items.map((p) => <PostCard key={p.id} post={p} compact />)
                )}
              </div>
            </div>
          );
        })}
      </div>
      {total === 0 && (
        <p className="mt-6 text-center text-sm text-gray-500">
          Nothing scheduled this week.{" "}
          <Link href="/compose" className="font-medium text-indigo-600 hover:text-indigo-500">
            Compose a post
          </Link>
        </p>
      )}
      <p className="mt-3 text-xs text-gray-400">Times shown in your local time zone. Drafts appear in the list view.</p>
    </>
  );
}

function PostCard({ post, compact }: { post: PostWithTargets; compact?: boolean }) {
  return (
    <Link
      href={`/posts/${post.id}`}
      className="block rounded-lg border border-gray-200 bg-white p-2.5 shadow-sm transition hover:border-indigo-300 hover:shadow"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-gray-900">{post.scheduled_at ? timeLabel(post.scheduled_at) : "Draft"}</span>
        {!compact && <StatusPill status={post.status} />}
        {compact && post.status !== "scheduled" && <StatusPill status={post.status} className="px-1.5! text-[10px]!" />}
      </div>
      <p className="mt-1 line-clamp-2 break-words text-xs text-gray-600">{snippet(post)}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        {post.targets.map((t) => (
          <PlatformBadge key={t.id} platform={t.platform} status={t.status} label={compact ? undefined : t.account_display_name} className="text-[10px]!" />
        ))}
      </div>
    </Link>
  );
}

function ListView({ posts }: { posts: PostWithTargets[] }) {
  const now = Date.now();
  const drafts = posts.filter((p) => !p.scheduled_at || p.status === "draft");
  const rest = posts.filter((p) => p.scheduled_at && p.status !== "draft");
  const upcoming = rest.filter((p) => new Date(p.scheduled_at!).getTime() >= now || p.status === "scheduled" || p.status === "publishing").sort(sortByTime);
  const upcomingIds = new Set(upcoming.map((p) => p.id));
  const past = rest.filter((p) => !upcomingIds.has(p.id)).sort((a, b) => sortByTime(b, a));

  if (posts.length === 0) {
    return (
      <Card>
        <div className="py-10 text-center">
          <p className="text-sm text-gray-500">No posts yet.</p>
          <Link href="/compose" className={buttonClasses("primary", "md", "mt-4")}>
            Compose your first post
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Section title="Upcoming" posts={upcoming} empty="Nothing upcoming." />
      <Section title="Past" posts={past} empty="No past posts." />
      {drafts.length > 0 && <Section title="Drafts" posts={drafts} empty="" />}
    </div>
  );
}

function Section({ title, posts, empty }: { title: string; posts: PostWithTargets[]; empty: string }) {
  return (
    <Card title={title} description={`${posts.length} post${posts.length === 1 ? "" : "s"}`} padded={false}>
      {posts.length === 0 ? (
        <p className="px-5 py-6 text-sm text-gray-400">{empty}</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {posts.map((p) => (
            <li key={p.id}>
              <Link href={`/posts/${p.id}`} className="flex flex-col gap-2 px-5 py-3.5 hover:bg-gray-50 sm:flex-row sm:items-center sm:gap-4">
                <div className="w-44 shrink-0 text-sm">
                  <p className="font-medium text-gray-900">
                    {p.scheduled_at
                      ? new Date(p.scheduled_at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
                      : "Draft"}
                  </p>
                  <p className="text-xs text-gray-500">{p.scheduled_at ? timeLabel(p.scheduled_at) : `Edited ${new Date(p.updated_at).toLocaleDateString()}`}</p>
                </div>
                <p className="min-w-0 flex-1 truncate text-sm text-gray-700">{snippet(p)}</p>
                <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                  {p.targets.map((t) => (
                    <PlatformBadge key={t.id} platform={t.platform} status={t.status} />
                  ))}
                  <StatusPill status={p.status} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
