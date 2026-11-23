import { getDb } from "../db";
import { pruneOld, runAutopilot } from "./pipeline";

// AutoPilot background loop (RUN_AUTOPILOT=true). Separate from the publisher loop: it only reads
// sources and the AI model and writes ap_ rows; it never publishes. Stopping it (unset the
// variable and redeploy) leaves publishing untouched.

export const AUTOPILOT_TICK_MS = 60_000;

let running = false;
let lastPrune = 0;
const PRUNE_EVERY_MS = 6 * 3_600_000;

/** One pass over every active autopilot of every user who hasn't hit the global pause. */
export async function autopilotTick(now: Date = new Date()): Promise<{ autopilots: number; drafts: number; errors: number }> {
  if (running) return { autopilots: 0, drafts: 0, errors: 0 };
  running = true;
  if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
    lastPrune = Date.now();
    try {
      const p = pruneOld(now);
      if (p.items || p.runs) console.log(`[autopilot] pruned items=${p.items} topics=${p.topics} runs=${p.runs}`);
    } catch (e) {
      console.error("[autopilot] prune failed:", e instanceof Error ? e.message : e);
    }
  }
  let drafts = 0;
  let errors = 0;
  try {
    const ids = getDb()
      .prepare(
        `SELECT a.id FROM autopilots a LEFT JOIN ap_settings s ON s.user_id = a.user_id
         WHERE a.status = 'active' AND COALESCE(s.paused, 0) = 0 ORDER BY a.last_run_at IS NOT NULL, a.last_run_at`,
      )
      .all() as { id: string }[];
    for (const { id } of ids) {
      try {
        const r = await runAutopilot(id, { trigger: "worker", now });
        if (r.draft_id) drafts++;
        if (r.error) {
          errors++;
          console.error(`[autopilot] ${id}: ${r.error}`);
        }
      } catch (e) {
        errors++;
        console.error(`[autopilot] ${id} crashed:`, e instanceof Error ? e.message : e);
      }
    }
    return { autopilots: ids.length, drafts, errors };
  } finally {
    running = false;
  }
}

export function startAutopilotWorker(): void {
  const intervalMs = Math.max(10_000, Number(process.env.AUTOPILOT_TICK_MS) || AUTOPILOT_TICK_MS);
  const tick = () => {
    autopilotTick()
      .then((r) => {
        if (r.drafts || r.errors) console.log(`[autopilot] autopilots=${r.autopilots} drafts=${r.drafts} errors=${r.errors}`);
      })
      .catch((e: unknown) => console.error("[autopilot] tick failed:", e instanceof Error ? e.message : e));
  };
  setInterval(tick, intervalMs).unref?.();
  setTimeout(tick, 15_000).unref?.();
  console.log(`[autopilot] worker started, checking every ${intervalMs / 1000}s (drafts only; nothing publishes without approval)`);
}
