import { requireUser } from "@/lib/auth";
import { approveDraft, type ApproveInput } from "@/lib/autopilot/handoff";
import { apHandle, readJson } from "../../../_shared";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ draftId: string }> };

/** Approve: creates a normal post in the existing queue (origin = autopilot). The scheduler publishes it. */
export async function POST(request: Request, ctx: Ctx) {
  return apHandle(async () => {
    const user = await requireUser();
    const { draftId } = await ctx.params;
    return approveDraft(user.id, draftId, (await readJson(request)) as ApproveInput);
  });
}
