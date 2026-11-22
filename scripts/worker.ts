// Long-running publisher for local dev / a VPS: `npm run worker`.
// (On Vercel, point Vercel Cron at /api/cron/publish instead.)
//
// Env is loaded BEFORE importing lib modules because lib/config.ts reads process.env at
// import time, and tsx (unlike `next dev`) doesn't load .env files on its own.

import fs from "node:fs";
import path from "node:path";

for (const f of [".env.local", ".env"]) {
  const p = path.join(process.cwd(), f);
  // loadEnvFile never overrides variables that are already set, so .env.local wins.
  if (fs.existsSync(p)) process.loadEnvFile(p);
}

const INTERVAL_MS = Math.max(1000, Number(process.env.WORKER_INTERVAL_MS) || 30_000);

async function main(): Promise<void> {
  const { processDuePosts } = await import("../lib/scheduler");

  let stopping = false;
  let wake: (() => void) | null = null;
  const stop = (sig: string) => {
    if (stopping) {
      console.log(`[worker] ${sig} again, exiting now`);
      process.exit(1);
    }
    stopping = true;
    console.log(`[worker] ${sig} received, finishing current run...`);
    wake?.();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  console.log(`[worker] started, polling every ${INTERVAL_MS / 1000}s`);
  while (!stopping) {
    const started = Date.now();
    try {
      const r = await processDuePosts();
      const ms = Date.now() - started;
      console.log(
        `[worker] ${new Date().toISOString()} processed=${r.processed} published=${r.published} failed=${r.failed} (${ms}ms)`,
      );
    } catch (e) {
      console.error("[worker] run failed:", e instanceof Error ? e.message : e);
    }
    if (stopping) break;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, INTERVAL_MS);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
    wake = null;
  }
  console.log("[worker] stopped");
}

main().catch((e) => {
  console.error("[worker] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
