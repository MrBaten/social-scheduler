import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { fillTemplate, ensureCredit, type StoryInput } from "@/lib/autopilot/generate";
import { requireAutopilot } from "@/lib/autopilot/store";
import type { ApItemRow } from "@/lib/autopilot/types";
import { apHandle, readJson } from "../../../_shared";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const SAMPLE: StoryInput = {
  headline: "Sample headline: a new tech hub opens in Dhaka",
  summary: "This is a sample summary used when the autopilot has not fetched any stories yet.",
  source_name: "Example News",
  source_url: "https://example.com/story",
  published_at: null,
  related_headlines: [],
};

/**
 * Live preview of a template on the newest relevant story (or a sample). Variables are filled
 * directly; with AI on, the model rewrites the content following the same structure.
 */
export async function POST(request: Request, ctx: Ctx) {
  return apHandle(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const ap = requireAutopilot(user.id, id);
    const { structure } = z.object({ structure: z.string().min(1).max(4000) }).parse(await readJson(request));
    const item = getDb()
      .prepare("SELECT * FROM ap_items WHERE autopilot_id = ? AND status = 'clustered' ORDER BY relevance DESC, fetched_at DESC LIMIT 1")
      .get(ap.id) as ApItemRow | undefined;
    const story: StoryInput = item
      ? { headline: item.title, summary: item.summary, source_name: item.publisher, source_url: item.url, published_at: item.published_at, related_headlines: [] }
      : SAMPLE;
    return { text: ensureCredit(fillTemplate(structure, story), story, ap.language), sample: !item, story };
  });
}
