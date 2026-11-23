import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getPost } from "@/lib/posts";
import { listDrafts, listRuns, listSources } from "@/lib/autopilot/store";
import { apHandle } from "../../_shared";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** Run log, reviewed drafts with their queue/publish results, failing sources, archive counts. */
export async function GET(_request: Request, ctx: Ctx) {
  return apHandle(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const runs = listRuns(user.id, id, 50);
    const reviewed = listDrafts(user.id, id, null, 200)
      .filter((d) => d.status !== "in_review")
      .slice(0, 100)
      .map((d) => {
        const post = d.post_id ? getPost(user.id, d.post_id) : null;
        return {
          ...d,
          post: post
            ? {
                id: post.id,
                status: post.status,
                scheduled_at: post.scheduled_at,
                targets: post.targets.map((t) => ({
                  platform: t.platform,
                  account: t.account_display_name,
                  status: t.status,
                  url: t.platform_post_url,
                  error: t.last_error,
                  published_at: t.published_at,
                })),
              }
            : null,
        };
      });
    const failingSources = listSources(user.id, id).filter((s) => s.error_count > 0 || (!s.enabled && s.last_error));
    const archived = getDb()
      .prepare("SELECT archive_reason AS reason, COUNT(*) AS n FROM ap_items WHERE autopilot_id = ? AND status = 'archived' GROUP BY archive_reason")
      .all(id) as { reason: string; n: number }[];
    return { runs, reviewed, failing_sources: failingSources, archived };
  });
}
