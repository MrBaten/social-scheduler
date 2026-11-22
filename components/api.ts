// Shared browser-side fetch helper for the JSON HTTP API.
// - Sends/receives JSON (or FormData when `body` is a FormData).
// - On 401 (outside the auth endpoints) redirects the browser to /login.
// - Throws ApiError with the parsed response body on non-2xx.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** JSON body (serialised for you). */
  json?: unknown;
  /** Raw body, e.g. FormData for uploads. */
  body?: BodyInit;
  /** Don't redirect to /login on 401 (used by the login form itself). */
  noAuthRedirect?: boolean;
  signal?: AbortSignal;
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: BodyInit | undefined = opts.body;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }

  const res = await fetch(path, {
    method: opts.method ?? (body ? "POST" : "GET"),
    headers,
    body,
    credentials: "same-origin",
    cache: "no-store",
    signal: opts.signal,
  });

  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 300) };
    }
  }

  if (res.status === 401 && !opts.noAuthRedirect && typeof window !== "undefined") {
    window.location.href = "/login";
    throw new ApiError(401, "Please log in again", data);
  }

  if (!res.ok) {
    throw new ApiError(res.status, errorMessage(data) ?? `Request failed (${res.status})`, data);
  }
  return data as T;
}

function errorMessage(data: unknown): string | null {
  if (data && typeof data === "object" && "error" in data) {
    const e = (data as { error: unknown }).error;
    if (typeof e === "string") return e;
  }
  return null;
}

/**
 * Pull per-target validation errors out of a 400 body. The contract shape is
 * `{ errors: { [social_account_id]: string[] } }`, but we also accept the
 * `HttpError` wrapper shape `{ error, details: { errors } }` / `{ details: {...} }`.
 */
export function extractTargetErrors(body: unknown): Record<string, string[]> | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const candidates: unknown[] = [b.errors];
  if (b.details && typeof b.details === "object") {
    const d = b.details as Record<string, unknown>;
    candidates.push(d.errors, d);
  }
  for (const c of candidates) {
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const out: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(c as Record<string, unknown>)) {
        if (Array.isArray(v)) out[k] = v.map(String);
        else if (typeof v === "string") out[k] = [v];
      }
      if (Object.keys(out).length) return out;
    }
  }
  return null;
}

/** Format an ISO timestamp in the browser's local time zone. */
export function formatLocal(iso: string | null | undefined, opts?: Intl.DateTimeFormatOptions): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, opts ?? { dateStyle: "medium", timeStyle: "short" });
}
