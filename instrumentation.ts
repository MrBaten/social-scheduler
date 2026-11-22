// Runs once when the Next.js server starts (`next start` / `next dev`).
//
// RUN_WORKER_IN_PROCESS=true runs the publishing loop inside the web server process. Use it on
// hosts where a separate worker can't share the SQLite volume (Railway: a volume attaches to ONE
// service and replicas can't use volumes), instead of `npm run worker` as a second service.
// Targets are claimed atomically in SQLite, so overlapping runs (this loop, publish-now, the cron
// route, even a separate worker process) never publish the same target twice.

export async function register(): Promise<void> {
  // Documented pattern: the NEXT_RUNTIME check must wrap the import so it's dropped from any edge build.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PHASE === "phase-production-build") return;

    if (process.env.NODE_ENV === "production") {
      if (!process.env.APP_URL) console.warn("[startup] APP_URL is not set: OAuth redirects and media URLs will point at localhost");
      if (!process.env.ENCRYPTION_KEY) console.warn("[startup] ENCRYPTION_KEY is not set: connecting accounts will fail");
      if (!process.env.CRON_SECRET) console.warn("[startup] CRON_SECRET is not set: /api/cron/publish is disabled");
    }

    if (process.env.RUN_WORKER_IN_PROCESS !== "true") return;
    const { processDuePosts } = await import("./lib/scheduler");
    const intervalMs = Math.max(1000, Number(process.env.WORKER_INTERVAL_MS) || 30_000);
    const tick = () => {
      processDuePosts()
        .then((r) => {
          if (r.processed > 0) console.log(`[worker] processed=${r.processed} published=${r.published} failed=${r.failed}`);
        })
        .catch((e: unknown) => console.error("[worker] run failed:", e instanceof Error ? e.message : e));
    };
    setInterval(tick, intervalMs).unref?.();
    setTimeout(tick, 5000).unref?.();
    console.log(`[worker] in-process publisher started, polling every ${intervalMs / 1000}s`);
  }
}
