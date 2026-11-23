import { z } from "zod";
import { assertSameOrigin, handle, HttpError } from "@/lib/api";
import { AuthError, createUser, startSession } from "@/lib/auth";
import { config } from "@/lib/config";
import { emailAllowed } from "@/lib/access";
import { clientIp, rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

const schema = z.object({
  email: z.email().max(254),
  name: z.string().max(100).optional().default(""),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

export async function POST(request: Request) {
  return handle(async () => {
    assertSameOrigin(request);
    const rl = rateLimit(`signup:${clientIp(request)}`, 10, 60 * 60_000);
    if (!rl.ok) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(rl.retryAfterSec / 60)} min.`);
    const body = schema.parse(await request.json().catch(() => ({})));
    if (!config.signupEnabled || !emailAllowed(body.email)) {
      throw new HttpError(403, "Sign-ups are closed for this workspace. Ask the owner for access.");
    }
    let user;
    try {
      user = await createUser(body.email, body.name, body.password);
    } catch (err) {
      if (err instanceof AuthError) throw new HttpError(409, err.message);
      throw err;
    }
    await startSession(user.id);
    return { user };
  });
}
