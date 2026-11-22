import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { handle } from "@/lib/api";
import { config } from "@/lib/config";
import { processDuePosts } from "@/lib/scheduler";

// Hit by Vercel Cron (which sends `Authorization: Bearer $CRON_SECRET`) or any external cron.
export const runtime = "nodejs";
export const maxDuration = 300;

function authorized(request: Request): boolean {
  if (!config.cronSecret) return process.env.NODE_ENV !== "production";
  const got = Buffer.from(request.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${config.cronSecret}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

async function run(request: Request): Promise<Response> {
  return handle(async () => {
    if (!authorized(request)) {
      const error = config.cronSecret ? "Unauthorized" : "CRON_SECRET is not configured";
      return NextResponse.json({ error }, { status: 401 });
    }
    return await processDuePosts();
  });
}

export const GET = run;
export const POST = run;
