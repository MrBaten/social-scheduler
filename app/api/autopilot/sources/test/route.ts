import { requireUser } from "@/lib/auth";
import { HttpError } from "@/lib/api";
import { rateLimit } from "@/lib/ratelimit";
import { SOURCE_ADAPTERS, fetchSourceItems } from "@/lib/autopilot/sources";
import { sourceInputSchema, validateSourceConfig } from "@/lib/autopilot/store";
import type { ApSourceType } from "@/lib/autopilot/types";
import { apHandle, readJson } from "../../_shared";

export const runtime = "nodejs";

/** Try a source without saving it: returns the request URL and the first items found. */
export async function POST(request: Request) {
  return apHandle(async () => {
    const user = await requireUser();
    if (!rateLimit(`ap-test:${user.id}`, 20, 60_000).ok) throw new HttpError(429, "Too many tests; wait a minute");
    const s = sourceInputSchema.parse(await readJson(request));
    validateSourceConfig(s);
    const cfg = { type: s.type as ApSourceType, url: s.url, query: s.query, params: s.params };
    const requestUrl = SOURCE_ADAPTERS[cfg.type].requestUrl(cfg);
    try {
      // Feed URLs are attacker-controlled: only http(s) links go back to the browser.
      const items = (await fetchSourceItems(cfg)).filter((i) => /^https?:\/\//i.test(i.url));
      return { ok: true, request_url: requestUrl, count: items.length, items: items.slice(0, 15) };
    } catch (e) {
      return { ok: false, request_url: requestUrl, count: 0, items: [], error: e instanceof Error ? e.message : String(e) };
    }
  });
}
