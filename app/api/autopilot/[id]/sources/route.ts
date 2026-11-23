import { requireUser } from "@/lib/auth";
import { addSource, listSources, type SourceInput } from "@/lib/autopilot/store";
import { apHandle, readJson } from "../../_shared";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, ctx: Ctx) {
  return apHandle(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    return { sources: listSources(user.id, id) };
  });
}

export async function POST(request: Request, ctx: Ctx) {
  return apHandle(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    return { source: addSource(user.id, id, (await readJson(request)) as SourceInput) };
  });
}
