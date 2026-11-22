import { assertSameOrigin, handle } from "@/lib/api";
import { endSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handle(async () => {
    assertSameOrigin(request);
    await endSession();
    return { ok: true };
  });
}
