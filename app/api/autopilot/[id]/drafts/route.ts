import { requireUser } from "@/lib/auth";
import { listDrafts } from "@/lib/autopilot/store";
import { apHandle } from "../../_shared";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** ?status=in_review (the inbox) | approved | rejected | scheduled. Newest first. */
export async function GET(request: Request, ctx: Ctx) {
  return apHandle(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const status = new URL(request.url).searchParams.get("status");
    return { drafts: listDrafts(user.id, id, status) };
  });
}
