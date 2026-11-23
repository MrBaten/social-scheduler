import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import type { LookupFunction } from "node:net";

// Server-side fetch for user-supplied feed URLs. Any logged-in user can add a source, so the server
// must not be usable to reach internal addresses (Railway private network, cloud metadata,
// localhost). Rules: http(s) only, no credentials in the URL, and every address we CONNECT to must
// be public. The check runs inside the socket's own DNS lookup (no gap between "check" and
// "connect", so DNS rebinding can't slip a private address in), IP-literal hosts are checked
// directly, IPv6 forms that embed an IPv4 address are unwrapped, redirects are followed manually
// (max 3) and re-checked, 15 s timeout, 2 MB body cap.

export class FetchError extends Error {}

export const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

function privateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Expand an IPv6 literal (with optional dotted IPv4 tail) to 8 hextets, or null if malformed. */
export function ipv6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const o = v4[1].split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    s = s.slice(0, -v4[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const parts = [...head, ...Array(fill).fill("0"), ...tail];
  if (parts.length !== 8 || parts.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  return parts.map((h) => parseInt(h, 16));
}

function v4FromHextets(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return privateV4(ip);
  if (!net.isIPv6(ip)) return true;
  const h = ipv6Hextets(ip);
  if (!h) return true;
  const zeroTo = (n: number) => h.slice(0, n).every((x) => x === 0);
  if (h.every((x) => x === 0)) return true; // ::
  if (zeroTo(7) && h[7] === 1) return true; // ::1
  // IPv4-mapped ::ffff:a.b.c.d, IPv4-translated ::ffff:0:a.b.c.d, IPv4-compatible ::a.b.c.d
  if (zeroTo(5) && h[5] === 0xffff) return privateV4(v4FromHextets(h[6], h[7]));
  if (zeroTo(4) && h[4] === 0xffff && h[5] === 0) return privateV4(v4FromHextets(h[6], h[7]));
  if (zeroTo(6)) return privateV4(v4FromHextets(h[6], h[7]));
  // NAT64 64:ff9b::/96 and 64:ff9b:1::/48 embed IPv4 in the last 32 bits
  if (h[0] === 0x64 && h[1] === 0xff9b) return privateV4(v4FromHextets(h[6], h[7]));
  // 6to4 2002:AABB:CCDD::/16 embeds IPv4 in hextets 1–2
  if (h[0] === 0x2002) return privateV4(v4FromHextets(h[1], h[2]));
  // Teredo 2001:0::/32 (obfuscated IPv4): block outright
  if (h[0] === 0x2001 && h[1] === 0) return true;
  const first = h[0];
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
    (first & 0xff00) === 0xff00 || // multicast
    first === 0x0100 // 100::/64 discard
  );
}

const BLOCKED_HOST = /(^localhost$|\.localhost$|\.local$|\.internal$|\.lan$|\.home$|\.arpa$|^metadata)/i;

/** Validate scheme, credentials and host name; IP-literal hosts are range-checked here. */
export function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchError("Not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new FetchError("Only http(s) URLs are allowed");
  if (u.username || u.password) throw new FetchError("URLs with credentials are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || BLOCKED_HOST.test(host)) throw new FetchError("That host is not allowed");
  if (net.isIP(host) && isPrivateIp(host)) throw new FetchError("Private network addresses are not allowed");
  return u;
}

type LookupAll = (host: string) => Promise<{ address: string; family: number }[]>;
const defaultLookupAll: LookupAll = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/** Resolve and reject private targets. Exported for tests (inject a fake resolver). */
export async function assertPublicUrl(raw: string, lookupAll: LookupAll = defaultLookupAll): Promise<URL> {
  const u = checkUrl(raw);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return u;
  let addrs: { address: string }[];
  try {
    addrs = await lookupAll(host);
  } catch {
    throw new FetchError(`Could not resolve ${host}`);
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new FetchError("That host resolves to a private network address");
  }
  return u;
}

/** DNS lookup used by the socket itself: refuses to hand back any private address. */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as dns.LookupAddress[];
    if (!list.length || list.some((a) => isPrivateIp(a.address))) {
      return callback(new FetchError("That host resolves to a private network address") as NodeJS.ErrnoException, "", 0);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

function userAgent(): string {
  const app = (process.env.APP_URL || "").replace(/\/$/, "");
  return `SocialSchedulerAutoPilot/1.0${app ? ` (+${app})` : ""}`;
}

interface RawResponse {
  status: number;
  location: string | null;
  body: Buffer;
}

/** Hard cap on one request including the body (the socket timeout only covers idle time). */
const TOTAL_MS = 30_000;

function requestOnce(u: URL, accept: string): Promise<RawResponse> {
  return new Promise<RawResponse>((resolveRaw, rejectRaw) => {
    let done = false;
    const timer = setTimeout(() => req.destroy(new FetchError("Request timed out")), TOTAL_MS);
    const resolve = (v: RawResponse) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveRaw(v);
    };
    const reject = (e: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rejectRaw(e);
    };
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      {
        method: "GET",
        lookup: safeLookup,
        headers: { "User-Agent": userAgent(), Accept: accept, "Accept-Encoding": "gzip, deflate, br" },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location: res.headers.location ?? null, body: Buffer.alloc(0) });
        }
        if (Number(res.headers["content-length"] || 0) > MAX_BYTES) {
          res.destroy();
          return reject(new FetchError("Response too large"));
        }
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        const stream =
          enc === "gzip" ? res.pipe(zlib.createGunzip()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : enc === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
        const chunks: Buffer[] = [];
        let total = 0;
        stream.on("data", (c: Buffer) => {
          total += c.length;
          if (total > MAX_BYTES) {
            res.destroy();
            stream.destroy();
            reject(new FetchError("Response too large"));
            return;
          }
          chunks.push(c);
        });
        stream.on("end", () => resolve({ status, location: null, body: Buffer.concat(chunks) }));
        stream.on("error", (e) => reject(new FetchError(`Could not read response: ${e.message}`)));
      },
    );
    req.on("timeout", () => req.destroy(new FetchError("Request timed out")));
    req.on("error", (e) => reject(e instanceof FetchError ? e : new FetchError(`Request failed: ${e.message}`)));
    req.end();
  });
}

/** GET a public URL and return its body as UTF-8 text. */
export async function fetchText(
  url: string,
  accept = "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.5",
): Promise<string> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = checkUrl(current);
    const res = await requestOnce(u, accept);
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw new FetchError(`HTTP ${res.status} without Location`);
      current = new URL(res.location, u).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new FetchError(`HTTP ${res.status}${res.status === 429 ? " (rate limited)" : ""}`);
    return res.body.toString("utf8");
  }
  throw new FetchError("Too many redirects");
}
