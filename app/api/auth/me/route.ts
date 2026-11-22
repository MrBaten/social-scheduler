import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET() {
  return handle(async () => ({ user: await requireUser() }));
}
