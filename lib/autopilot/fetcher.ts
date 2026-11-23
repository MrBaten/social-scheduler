import dns from "node:dns/promises";
import net from "node:net";

// Server-side fetch for user-supplied feed URLs. Because any logged-in user can add a source, the
// server must not be usable to reach internal addresses (Railway private network, metadata IPs,
// localhost). Checks: http(s) only, no credentials in URL, hostname must not be or resolve to a
// private/loopback/link-local address, redirects followed manually (max 3) and re-checked, 15 s
// timeout, 3 MB body cap. Residual risk: DNS rebinding between our lookup and fetch's own lookup.

export class FetchError extends Error {}

const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
  }
  return true;
}

const BLOCKED_HOST = /(^localhost$|\.localhost$|\.local$|\.internal$|\.lan$|\.home$|^metadata)/i;

/** Throws FetchError when the URL is not an allowed public http(s) URL. */
export async function assertPublicUrl(raw: string, lookup: typeof dns.lookup = dns.lookup): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchError("Not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new FetchError("Only http(s) URLs are allowed");
  if (u.username || u.password) throw new FetchError("URLs with credentials are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (BLOCKED_HOST.test(host)) throw new FetchError("That host is not allowed");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new FetchError("Private network addresses are not allowed");
    return u;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new FetchError(`Could not resolve ${host}`);
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new FetchError("That host resolves to a private network address");
  }
  return u;
}

function userAgent(): string {
  const app = (process.env.APP_URL || "").replace(/\/$/, "");
  return `SocialSchedulerAutoPilot/1.0${app ? ` (+${app})` : ""}`;
}

/** GET a public URL and return its body as text. */
export async function fetchText(url: string, accept = "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.5"): Promise<string> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await assertPublicUrl(current);
    let res: Response;
    try {
      res = await fetch(u, {
        redirect: "manual",
        headers: { "User-Agent": userAgent(), Accept: accept },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (e) {
      const msg = e instanceof Error ? (e.name === "TimeoutError" ? "timed out" : e.message) : String(e);
      throw new FetchError(`Request failed: ${msg}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new FetchError(`HTTP ${res.status} without Location`);
      current = new URL(loc, u).toString();
      continue;
    }
    if (!res.ok) throw new FetchError(`HTTP ${res.status}${res.status === 429 ? " (rate limited)" : ""}`);
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_BYTES) throw new FetchError("Response too large");
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new FetchError("Response too large");
      }
      chunks.push(value);
    }
    return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
  }
  throw new FetchError("Too many redirects");
}
