import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness + DB check for the host's health probe. No auth, no data. */
export async function GET() {
  try {
    getDb().prepare("SELECT 1").get();
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
