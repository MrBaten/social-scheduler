import { NextResponse } from "next/server";
import { handle, HttpError } from "@/lib/api";
import { PostValidationError } from "@/lib/posts";

/** Like handle(), but renders PostValidationError as `{ error, errors: { [accountId]: string[] } }`. */
export function handlePosts<T>(fn: () => Promise<T>): Promise<Response> {
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

/** Parse a JSON body; malformed JSON -> 400. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
}
