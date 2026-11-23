import { z } from "zod";
import { assertSameOrigin, handle, HttpError } from "@/lib/api";
import { startSession, verifyLogin } from "@/lib/auth";
import { emailAllowed } from "@/lib/access";
import { clientIp, rateLimit } from "@/lib/ratelimit";

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
    const email = parsed.data.email.trim().toLowerCase();
    const ip = clientIp(request);
    // 10 tries per email+IP and 30 per IP every 15 minutes.
    const a = rateLimit(`login:${ip}:${email}`, 10, 15 * 60_000);
    const b = rateLimit(`login-ip:${ip}`, 30, 15 * 60_000);
    if (!a.ok || !b.ok) {
      const wait = Math.max(a.retryAfterSec, b.retryAfterSec);
      throw new HttpError(429, `Too many login attempts. Try again in ${Math.ceil(wait / 60)} min.`);
    }
    if (!emailAllowed(email)) throw new HttpError(401, "Invalid email or password");
    const user = await verifyLogin(parsed.data.email, parsed.data.password);
    if (!user) throw new HttpError(401, "Invalid email or password");
    await startSession(user.id);
    return { user };
  });
}
