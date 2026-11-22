import { z } from "zod";
import { assertSameOrigin, handle, HttpError } from "@/lib/api";
import { AuthError, createUser, startSession } from "@/lib/auth";

export const runtime = "nodejs";

const schema = z.object({
  email: z.email().max(254),
  name: z.string().max(100).optional().default(""),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

export async function POST(request: Request) {
  return handle(async () => {
    assertSameOrigin(request);
    const body = schema.parse(await request.json().catch(() => ({})));
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
