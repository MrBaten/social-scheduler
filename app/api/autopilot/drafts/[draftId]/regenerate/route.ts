import { requireUser } from "@/lib/auth";
import { HttpError } from "@/lib/api";
import { rateLimit } from "@/lib/ratelimit";
import { regenerateDraft } from "@/lib/autopilot/pipeline";
import { getDraft } from "@/lib/autopilot/store";
import { apHandle } from "../../../_shared";

export const runtime = "nodejs";
export const maxDuration = 120;

type Ctx = { params: Promise<{ draftId: string }> };

/** New wording for the same story (one AI call, counted against the daily cap). */
export async function POST(_request: Request, ctx: Ctx) {
  return apHandle(async () => {
    const user = await requireUser();
    const { draftId } = await ctx.params;
    if (!rateLimit(`ap-regen:${user.id}`, 20, 60_000).ok) throw new HttpError(429, "Too many regenerations; wait a minute");
    await regenerateDraft(user.id, draftId);
    return { draft: getDraft(user.id, draftId) };
  });
}
