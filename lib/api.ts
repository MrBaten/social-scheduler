import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthError } from "./auth";

/** Wrap a Route Handler body: maps AuthError->401, ZodError->400, HttpError->status, else 500. */
export async function handle<T>(fn: () => Promise<T>): Promise<Response> {
  try {
    const result = await fn();
    if (result instanceof Response) return result;
    return NextResponse.json(result ?? { ok: true });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: 401 });
    if (err instanceof ZodError) return NextResponse.json({ error: "Invalid input", issues: err.issues }, { status: 400 });
    if (err instanceof HttpError) return NextResponse.json({ error: err.message, details: err.details }, { status: err.status });
    console.error("[api] unhandled", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

/**
 * Reject cross-site requests on cookie-setting endpoints (login/signup/logout). SameSite=Lax
 * already keeps the session cookie off cross-site POSTs, but login/signup don't need a cookie:
 * without this, a hostile page could auto-submit a form that logs the victim into the
 * attacker's account ("login CSRF"), and the victim's OAuth connections would land there.
 * Browsers send Sec-Fetch-Site and/or Origin on every POST; non-browser clients send neither.
 */
export function assertSameOrigin(request: Request): void {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, "Cross-site request rejected");
  const origin = request.headers.get("origin");
  if (!origin) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, "Cross-site request rejected");
  }
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(process.env.APP_URL || "http://localhost:3000").host);
  } catch {
    /* ignore */
  }
  // Behind a reverse proxy (Railway) the public host arrives in X-Forwarded-Host.
  for (const h of [request.headers.get("x-forwarded-host"), request.headers.get("host")]) {
    if (h) allowed.add(h.split(",")[0].trim());
  }
  if (!allowed.has(originHost)) throw new HttpError(403, "Cross-site request rejected");
}
