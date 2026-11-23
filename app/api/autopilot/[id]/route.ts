import { requireUser } from "@/lib/auth";
import { HttpError } from "@/lib/api";
import { summarizeAutopilots } from "@/lib/autopilot/pipeline";
import { deleteAutopilot, requireAutopilot, updateAutopilot } from "@/lib/autopilot/store";
import { apHandle, readJson } from "../_shared";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, ctx: Ctx) {
  return apHandle(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    requireAutopilot(user.id, id);
    const summary = summarizeAutopilots(user.id).find((a) => a.id === id)!;
    return { autopilot: summary };
  });
}

export async function PATCH(request: Request, ctx: Ctx) {
  return apHandle(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    return { autopilot: updateAutopilot(user.id, id, await readJson(request)) };
  });
}

export async function DELETE(_request: Request, ctx: Ctx) {
  return apHandle(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    if (!deleteAutopilot(user.id, id)) throw new HttpError(404, "Autopilot not found");
    return { ok: true };
  });
}
