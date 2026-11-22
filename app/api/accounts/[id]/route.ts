import { handle, HttpError } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { deleteAccount } from "@/lib/accounts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** Disconnect: deletes the account (and, via FK cascade, its post targets). */
export async function DELETE(_request: Request, ctx: Ctx) {
  return handle(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    if (!deleteAccount(user.id, id)) throw new HttpError(404, "Account not found");
    return { ok: true };
  });
}
