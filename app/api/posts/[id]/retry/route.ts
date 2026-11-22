import { requireUser } from "@/lib/auth";
import { retryFailed } from "@/lib/posts";
import { handlePosts } from "../../_shared";

export const runtime = "nodejs";

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handlePosts(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    return { post: retryFailed(user.id, id) };
  });
}
