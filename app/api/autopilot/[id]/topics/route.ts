import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { requireAutopilot } from "@/lib/autopilot/store";
import { apHandle } from "../../_shared";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** Recent story clusters with scores (read-only in Phase 1; pin/block is Phase 2). */
export async function GET(_request: Request, ctx: Ctx) {
  return apHandle(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    requireAutopilot(user.id, id);
    const topics = getDb()
      .prepare(
        `SELECT t.id, t.headline, t.item_count, t.best_score, t.status, t.first_seen_at, t.last_seen_at, t.used_at,
                i.url AS best_url, i.publisher AS best_publisher
         FROM ap_topics t LEFT JOIN ap_items i ON i.id = t.best_item_id
         WHERE t.autopilot_id = ? ORDER BY t.last_seen_at DESC LIMIT 100`,
      )
      .all(id);
    return { topics };
  });
}
