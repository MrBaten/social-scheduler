import { requireUser } from "@/lib/auth";
import { HttpError } from "@/lib/api";
import { deletePost, getPost, updatePost, updatePostSchema } from "@/lib/posts";
import { handlePosts, readJson } from "../_shared";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, ctx: Ctx) {
  return handlePosts(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const post = getPost(user.id, id);
    if (!post) throw new HttpError(404, "Post not found");
    return { post };
  });
}

export async function PATCH(request: Request, ctx: Ctx) {
  return handlePosts(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = updatePostSchema.parse(await readJson(request));
    return { post: updatePost(user.id, id, body) };
  });
}

export async function DELETE(_request: Request, ctx: Ctx) {
  return handlePosts(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    if (!deletePost(user.id, id)) throw new HttpError(404, "Post not found");
    return { ok: true };
  });
}
