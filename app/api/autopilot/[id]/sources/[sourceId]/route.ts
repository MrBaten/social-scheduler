import { requireUser } from "@/lib/auth";
import { HttpError } from "@/lib/api";
import { deleteSource, updateSource } from "@/lib/autopilot/store";
import { apHandle, readJson } from "../../../_shared";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; sourceId: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  return apHandle(async () => {
    const user = await requireUser();
    const { id, sourceId } = await ctx.params;
    return { source: updateSource(user.id, id, sourceId, await readJson(request)) };
  });
}

export async function DELETE(_request: Request, ctx: Ctx) {
  return apHandle(async () => {
    const user = await requireUser();
    const { id, sourceId } = await ctx.params;
    if (!deleteSource(user.id, id, sourceId)) throw new HttpError(404, "Source not found");
    return { ok: true };
  });
}
