import { requireUser } from "@/lib/auth";
import { aiStatus } from "@/lib/autopilot/ai";
import { summarizeAutopilots } from "@/lib/autopilot/pipeline";
import { createAutopilot, isGloballyPaused, type AutopilotInput, type SourceInput, type TemplateInput } from "@/lib/autopilot/store";
import { apHandle, readJson } from "./_shared";

export const runtime = "nodejs";

/** Overview: every autopilot of the user with today's counts, plus the global pause and AI status. */
export async function GET() {
  return apHandle(async () => {
    const user = await requireUser();
    const autopilots = summarizeAutopilots(user.id);
    const { configured, provider, model, problem } = aiStatus();
    return {
      autopilots,
      paused: isGloballyPaused(user.id),
      ai: { configured, provider, model: configured ? model : null, problem },
      worker_enabled: process.env.RUN_AUTOPILOT === "true",
      inbox_total: autopilots.reduce((n, a) => n + a.today.inbox, 0),
    };
  });
}

/** Create from the setup wizard: profile + sources + templates in one call. */
export async function POST(request: Request) {
  return apHandle(async () => {
    const user = await requireUser();
    const body = (await readJson(request)) as AutopilotInput & { sources?: SourceInput[]; templates?: TemplateInput[] };
    return { autopilot: createAutopilot(user.id, body) };
  });
}
