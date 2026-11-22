"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { PostWithTargets, TargetOptions } from "@/lib/types";
import { api, ApiError, formatLocal } from "./api";
import { Button, buttonClasses, Spinner } from "./Button";
import { Alert, Card, PageHeader } from "./Card";
import { ConfirmButton } from "./ConfirmButton";
import { PlatformBadge } from "./PlatformBadge";
import { StatusPill } from "./StatusPill";

const REFRESH_MS = 5_000;

function parseOptions(json: string | null | undefined): TargetOptions {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" ? (v as TargetOptions) : {};
  } catch {
    return {};
  }
}

function optionsSummary(o: TargetOptions): string {
  const parts: string[] = [];
  if (o.title) parts.push(`Title: ${o.title}`);
  if (o.privacy) parts.push(`Privacy: ${o.privacy.replace("_", " ")}`);
  if (o.ig_type) parts.push(`Type: ${o.ig_type}`);
  if (o.link) parts.push(`Link: ${o.link}`);
  return parts.join(" · ");
}

export function PostDetail({ id }: { id: string }) {
  const router = useRouter();
  const [post, setPost] = useState<PostWithTargets | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "retry" | "publish">(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ post: PostWithTargets } | PostWithTargets>(`/api/posts/${id}`);
      const p = "post" in r ? r.post : r;
      setPost(p);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else setError(e instanceof Error ? e.message : "Could not load post");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = !!post?.targets.some((t) => t.status === "pending" || t.status === "publishing");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [active, load]);

  async function action(kind: "retry" | "publish") {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/posts/${id}/${kind === "retry" ? "retry" : "publish-now"}`, { method: "POST" });
      setNotice(kind === "retry" ? "Failed targets queued for retry." : "Publishing started.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    try {
      await api(`/api/posts/${id}`, { method: "DELETE" });
      router.push("/queue");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete post");
    }
  }

  if (notFound) {
    return (
      <Card>
        <div className="py-10 text-center">
          <p className="text-base font-semibold text-gray-900">Post not found</p>
          <p className="mt-1 text-sm text-gray-500">It may have been deleted.</p>
          <Link href="/queue" className={buttonClasses("secondary", "md", "mt-5")}>
            Back to queue
          </Link>
        </div>
      </Card>
    );
  }

  if (!post) {
    return error ? (
      <Alert tone="error">{error}</Alert>
    ) : (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Spinner /> Loading post…
      </div>
    );
  }

  const failed = post.targets.filter((t) => t.status === "failed").length;
  const pending = post.targets.filter((t) => t.status === "pending").length;
  const publishedCount = post.targets.filter((t) => t.status === "published").length;

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            Post
            <StatusPill status={post.status} className="text-sm" />
          </span>
        }
        description={
          post.scheduled_at ? (
            <>
              Scheduled for <span className="font-medium text-gray-700">{formatLocal(post.scheduled_at, { dateStyle: "full", timeStyle: "short" })}</span>{" "}
              (your local time)
            </>
          ) : (
            "Draft — not scheduled"
          )
        }
        actions={
          <>
            <Link href="/queue" className={buttonClasses("ghost", "sm")}>
              ← Queue
            </Link>
            {failed > 0 && (
              <Button variant="secondary" size="sm" onClick={() => action("retry")} loading={busy === "retry"} disabled={!!busy}>
                Retry failed ({failed})
              </Button>
            )}
            {pending > 0 && (
              <Button size="sm" onClick={() => action("publish")} loading={busy === "publish"} disabled={!!busy}>
                Publish now
              </Button>
            )}
            <ConfirmButton label="Delete" confirmLabel="Delete post" onConfirm={remove} />
          </>
        }
      />

      {error && (
        <Alert tone="error" className="mb-4">
          {error}
        </Alert>
      )}
      {notice && (
        <Alert tone="success" className="mb-4">
          {notice}
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-6">
          <Card title="Content">
            {post.base_text ? (
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-800">{post.base_text}</p>
            ) : (
              <p className="text-sm italic text-gray-400">No base text.</p>
            )}
            {post.media.length > 0 && (
              <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {post.media.map((m) => (
                  <li key={m.id} className="overflow-hidden rounded-xl border border-gray-200 bg-gray-100">
                    {m.mime_type.startsWith("image/") ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={m.public_url} alt={m.filename} className="aspect-square w-full object-cover" />
                    ) : (
                      <video src={m.public_url} controls preload="metadata" className="aspect-square w-full bg-black object-contain" />
                    )}
                    <p className="truncate bg-white px-2 py-1 text-xs text-gray-500" title={m.filename}>
                      {m.filename}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card
            title="Destinations"
            description={`${publishedCount} of ${post.targets.length} published`}
            actions={active ? <span className="flex items-center gap-1.5 text-xs text-gray-400"><Spinner className="h-3 w-3" /> Live</span> : undefined}
            padded={false}
          >
            {/* Table on wide screens, stacked cards on mobile. */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-5 py-2.5 font-medium">Account</th>
                    <th className="px-3 py-2.5 font-medium">Status</th>
                    <th className="px-3 py-2.5 font-medium">Attempts</th>
                    <th className="px-3 py-2.5 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {post.targets.map((t) => {
                    const opts = optionsSummary(parseOptions(t.options_json));
                    return (
                      <tr key={t.id} className="align-top">
                        <td className="px-5 py-3">
                          <PlatformBadge platform={t.platform} />
                          <p className="mt-1 font-medium text-gray-900">{t.account_display_name}</p>
                          {opts && <p className="mt-0.5 text-xs text-gray-500">{opts}</p>}
                        </td>
                        <td className="px-3 py-3">
                          <StatusPill status={t.status} />
                        </td>
                        <td className="px-3 py-3 tabular-nums text-gray-700">{t.attempts}</td>
                        <td className="px-3 py-3">
                          <TargetDetails t={t} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-gray-100 md:hidden">
              {post.targets.map((t) => {
                const opts = optionsSummary(parseOptions(t.options_json));
                return (
                  <li key={t.id} className="space-y-2 px-5 py-4">
                    <div className="flex items-center justify-between gap-2">
                      <PlatformBadge platform={t.platform} label={t.account_display_name} />
                      <StatusPill status={t.status} />
                    </div>
                    {opts && <p className="text-xs text-gray-500">{opts}</p>}
                    <p className="text-xs text-gray-500">Attempts: {t.attempts}</p>
                    <TargetDetails t={t} />
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Timeline">
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs text-gray-500">Created</dt>
                <dd className="text-gray-800">{formatLocal(post.created_at)}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">Scheduled</dt>
                <dd className="text-gray-800">{formatLocal(post.scheduled_at)}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">Last updated</dt>
                <dd className="text-gray-800">{formatLocal(post.updated_at)}</dd>
              </div>
            </dl>
          </Card>
          {post.targets.some((t) => t.text_override) && (
            <Card title="Custom text">
              <ul className="space-y-4">
                {post.targets
                  .filter((t) => t.text_override)
                  .map((t) => (
                    <li key={t.id}>
                      <PlatformBadge platform={t.platform} label={t.account_display_name} />
                      <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-gray-700">{t.text_override}</p>
                    </li>
                  ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function TargetDetails({ t }: { t: PostWithTargets["targets"][number] }) {
  return (
    <div className="space-y-1 text-xs">
      {t.status === "published" && (
        <p className="text-gray-600">
          Published {formatLocal(t.published_at)}
          {t.platform_post_url && (
            <>
              {" · "}
              <a href={t.platform_post_url} target="_blank" rel="noopener noreferrer" className="font-medium text-indigo-600 hover:text-indigo-500">
                View post ↗
              </a>
            </>
          )}
        </p>
      )}
      {t.status === "pending" && t.next_attempt_at && <p className="text-gray-600">Next attempt {formatLocal(t.next_attempt_at)}</p>}
      {t.status === "publishing" && <p className="text-blue-700">Publishing…</p>}
      {t.last_error && <p className="break-words rounded-md bg-red-50 px-2 py-1 text-red-700">{t.last_error}</p>}
      {t.status !== "published" && !t.last_error && !(t.status === "pending" && t.next_attempt_at) && t.status !== "publishing" && (
        <p className="text-gray-400">—</p>
      )}
    </div>
  );
}
