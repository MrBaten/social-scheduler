import { z } from "zod";
import { assertSameOrigin, handle, HttpError } from "@/lib/api";
import { startSession, verifyLogin } from "@/lib/auth";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().max(254),
  password: z.string().max(200),
});

export async function POST(request: Request) {
  return handle(async () => {
    assertSameOrigin(request);
    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(401, "Invalid email or password");
    const user = await verifyLogin(parsed.data.email, parsed.data.password);
    if (!user) throw new HttpError(401, "Invalid email or password");
    await startSession(user.id);
    return { user };
  });
}
