import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { HttpError } from "@/lib/api";
import { rateLimit } from "@/lib/ratelimit";
import { runAutopilot } from "@/lib/autopilot/pipeline";
import { requireAutopilot } from "@/lib/autopilot/store";
import { apHandle, readJson } from "../../_shared";

export const runtime = "nodejs";
// Fetching every source (GDELT is throttled to 1 request / 5.5 s) plus one AI call can take a while.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/** "Run now": fetch all enabled sources and (unless generate=false) write one draft to the inbox. */
export async function POST(request: Request, ctx: Ctx) {
  return apHandle(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    requireAutopilot(user.id, id);
    if (!rateLimit(`ap-run:${user.id}`, 10, 60_000).ok) throw new HttpError(429, "Too many runs; wait a minute");
    const { generate } = z.object({ generate: z.boolean().default(true) }).parse(await readJson(request));
    const r = await runAutopilot(id, { trigger: "manual", forceFetch: true, forceGenerate: generate });
    if (r.skipped_reason === "already running") throw new HttpError(409, "This autopilot is already running; try again in a minute");
    return { result: r };
  });
}
