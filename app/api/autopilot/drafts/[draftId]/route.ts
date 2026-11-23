import { requireUser } from "@/lib/auth";
import { HttpError } from "@/lib/api";
import { editDraft, getDraft } from "@/lib/autopilot/store";
import { apHandle, readJson } from "../../_shared";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ draftId: string }> };

export async function GET(_request: Request, ctx: Ctx) {
  return apHandle(async () => {
    const user = await requireUser();
    const { draftId } = await ctx.params;
    const d = getDraft(user.id, draftId);
    if (!d) throw new HttpError(404, "Draft not found");
    return { draft: d };
  });
}

/** Edit per-platform texts and/or attach an image (media id from POST /api/media). */
export async function PATCH(request: Request, ctx: Ctx) {
  return apHandle(async () => {
    const user = await requireUser();
    const { draftId } = await ctx.params;
    return { draft: editDraft(user.id, draftId, await readJson(request)) };
  });
}
