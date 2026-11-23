import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { aiStatus } from "@/lib/autopilot/ai";
import { isGloballyPaused, setGlobalPause } from "@/lib/autopilot/store";
import { apHandle, readJson } from "../_shared";

export const runtime = "nodejs";

export async function GET() {
  return apHandle(async () => {
    const user = await requireUser();
    const { configured, provider, model, problem } = aiStatus();
    return { paused: isGloballyPaused(user.id), ai: { configured, provider, model: configured ? model : null, problem } };
  });
}

/** Global pause: stops all drafting for this user. Posts already approved stay in the queue. */
export async function PATCH(request: Request) {
  return apHandle(async () => {
    const user = await requireUser();
    const { paused } = z.object({ paused: z.boolean() }).parse(await readJson(request));
    setGlobalPause(user.id, paused);
    return { paused: isGloballyPaused(user.id) };
  });
}
