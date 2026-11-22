import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { listAccounts } from "@/lib/accounts";

export const runtime = "nodejs";

export async function GET() {
  return handle(async () => {
    const user = await requireUser();
    return { accounts: listAccounts(user.id) };
  });
}
