import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { rejectDraft } from "@/lib/autopilot/store";
import { apHandle, readJson } from "../../../_shared";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ draftId: string }> };

export async function POST(request: Request, ctx: Ctx) {
  return apHandle(async () => {
    const user = await requireUser();
    const { draftId } = await ctx.params;
    const { reason } = z.object({ reason: z.string().max(500).default("") }).parse(await readJson(request));
    return { draft: rejectDraft(user.id, draftId, reason) };
  });
}
