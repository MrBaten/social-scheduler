import { PublishError } from "../types";

// Small fetch wrapper shared by all adapters: timeout + JSON parsing + mapping provider
// errors into PublishError so the scheduler can decide retry vs fail.
//
// Classification:
//   - network error / timeout              -> retryable
//   - 401, or provider "invalid token" code -> non-retryable + tokenExpired
//   - 429, 5xx, provider "transient" flags  -> retryable
//   - other 4xx                             -> non-retryable

export interface HttpOptions extends Omit<RequestInit, "signal"> {
  timeoutMs?: number;
  /** Label for error messages, e.g. "Facebook". */
  label?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** The request failed without a response (network error / timeout): it may or may not have reached the provider. */
export class NetworkError extends PublishError {
  constructor(message: string) {
    super(message, true);
    this.name = "NetworkError";
  }
}

/**
 * Wrap the step that actually CREATES the post (feed POST, media_publish, ...). If it fails
 * without a response (timeout / connection reset) the post may already be live, and an
 * automatic retry would publish a duplicate, so the error becomes non-retryable with a hint.
 * HTTP error responses keep their normal retry classification.
 */
export async function noRetryIfUncertain<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NetworkError) {
      throw new PublishError(
        `${err.message}. The post may have been published anyway; check ${label} before retrying.`,
        false,
      );
    }
    throw err;
  }
}

/** fetch with timeout; throws PublishError on network failure or non-2xx. */
export async function http(url: string, opts: HttpOptions = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, label = "Provider", ...init } = opts;
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const e = err as Error;
    const msg = e?.name === "TimeoutError" ? `timed out after ${Math.round(timeoutMs / 1000)}s` : e?.message || String(err);
    throw new NetworkError(`${label}: network error (${msg})`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw errorFromResponse(label, res.status, text);
  }
  return res;
}

/** Like http() but parses the JSON body. */
export async function httpJson<T = any>(url: string, opts: HttpOptions = {}): Promise<{ data: T; res: Response }> {
  const res = await http(url, opts);
  const text = await res.text();
  if (!text) return { data: {} as T, res };
  try {
    return { data: JSON.parse(text) as T, res };
  } catch {
    throw new PublishError(`${opts.label ?? "Provider"}: invalid JSON response`, true);
  }
}

/** Form-encoded body helper (drops undefined values). */
export function form(params: Record<string, string | number | boolean | undefined | null>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) p.set(k, String(v));
  return p;
}

const META_TOKEN_CODES = new Set([190, 102, 463, 467]);
const META_TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613, 80001]);
const TOKEN_ERROR_STRINGS = ["access_token_invalid", "invalid_token", "invalid_grant", "expired_token", "token_expired"];

/** Build a PublishError from a non-2xx response, understanding Meta/LinkedIn/Google/TikTok error shapes. */
export function errorFromResponse(label: string, status: number, bodyText: string): PublishError {
  let body: any = null;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    body = null;
  }
  const errObj = body && typeof body.error === "object" && body.error !== null ? body.error : null;
  // Message extraction across provider shapes:
  //   Meta:     { error: { message, code, error_subcode, is_transient, error_user_msg } }
  //   Google:   { error: { code, message, errors: [{ reason }] } }  | OAuth: { error, error_description }
  //   LinkedIn: { message, status, serviceErrorCode }               | OAuth: { error, error_description }
  //   TikTok:   { error: { code, message, log_id } }                | OAuth: { error, error_description }
  const message: string =
    errObj?.error_user_msg ||
    errObj?.message ||
    body?.error_description ||
    body?.message ||
    (typeof body?.error === "string" ? body.error : "") ||
    bodyText.slice(0, 300) ||
    `HTTP ${status}`;
  const code = errObj?.code;
  const codeStr = typeof code === "string" ? code : typeof body?.error === "string" ? body.error : "";
  const reason: string = errObj?.errors?.[0]?.reason || "";

  const full = `${label}: ${message}${status ? ` (HTTP ${status})` : ""}`;

  const tokenProblem =
    status === 401 ||
    (typeof code === "number" && META_TOKEN_CODES.has(code)) ||
    TOKEN_ERROR_STRINGS.includes(codeStr) ||
    reason === "authError";
  if (tokenProblem) return new PublishError(full, false, true);

  const transient =
    status === 429 ||
    status >= 500 ||
    errObj?.is_transient === true ||
    (typeof code === "number" && META_TRANSIENT_CODES.has(code)) ||
    codeStr === "rate_limit_exceeded" ||
    codeStr === "internal_error" ||
    reason === "rateLimitExceeded" ||
    reason === "backendError";
  return new PublishError(full, transient, false);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll fn() until it returns a non-undefined value or the deadline passes. */
export async function poll<T>(
  fn: () => Promise<T | undefined>,
  { intervalMs, timeoutMs }: { intervalMs: number; timeoutMs: number },
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() + intervalMs > deadline) return undefined;
    await sleep(intervalMs);
  }
}

export function expiresAtFromSeconds(expiresIn: unknown): string | null {
  const n = Number(expiresIn);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(Date.now() + n * 1000).toISOString();
}
