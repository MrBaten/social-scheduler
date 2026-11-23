import { NextResponse } from "next/server";
import { handle, HttpError } from "@/lib/api";
import { PostValidationError } from "@/lib/posts";

/** handle() plus PostValidationError -> 400 `{ error, errors }` (approve runs Compose's validation). */
export function apHandle<T>(fn: () => Promise<T>): Promise<Response> {
  return handle(async () => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PostValidationError) {
        return NextResponse.json({ error: err.message, errors: err.errors }, { status: 400 });
      }
      throw err;
    }
  });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "Body must be a JSON object");
}
