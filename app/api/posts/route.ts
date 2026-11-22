import { requireUser } from "@/lib/auth";
import { createPost, createPostSchema, listPosts } from "@/lib/posts";
import type { CreatePostInput } from "@/lib/types";
import { handlePosts, readJson } from "./_shared";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return handlePosts(async () => {
    const user = await requireUser();
    const url = new URL(request.url);
    return { posts: listPosts(user.id, url.searchParams.get("from"), url.searchParams.get("to")) };
  });
}

export async function POST(request: Request) {
  return handlePosts(async () => {
    const user = await requireUser();
    const body = createPostSchema.parse(await readJson(request)) as CreatePostInput;
    return { post: createPost(user.id, body) };
  });
}
