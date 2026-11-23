import { requireUser } from "@/lib/auth";
import { HttpError } from "@/lib/api";
import { deleteTemplate, updateTemplate } from "@/lib/autopilot/store";
import { apHandle, readJson } from "../../../_shared";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; templateId: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  return apHandle(async () => {
    const user = await requireUser();
    const { id, templateId } = await ctx.params;
    return { template: updateTemplate(user.id, id, templateId, await readJson(request)) };
  });
}

export async function DELETE(_request: Request, ctx: Ctx) {
  return apHandle(async () => {
    const user = await requireUser();
    const { id, templateId } = await ctx.params;
    if (!deleteTemplate(user.id, id, templateId)) throw new HttpError(404, "Template not found");
    return { ok: true };
  });
}
