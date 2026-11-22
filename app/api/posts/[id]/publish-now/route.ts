import { requireUser } from "@/lib/auth";
import { getPost, publishNow } from "@/lib/posts";
import { processDuePosts } from "@/lib/scheduler";
import { handlePosts } from "../../_shared";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Don't hold the request open for slow uploads (YouTube/TikTok); the run continues in the background. */
const WAIT_CAP_MS = 25_000;

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handlePosts(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    publishNow(user.id, id);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = processDuePosts().catch((e: unknown) => {
      console.error("[publish-now] scheduler run failed", e instanceof Error ? e.message : e);
    });
    await Promise.race([run, new Promise<void>((resolve) => (timer = setTimeout(resolve, WAIT_CAP_MS)))]);
    if (timer) clearTimeout(timer);

    return { post: getPost(user.id, id) };
  });
}
