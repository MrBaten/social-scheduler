import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { ALLOWED_MIME, uploadsDir } from "@/lib/media";

export const runtime = "nodejs";

const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(ALLOWED_MIME).map(([mime, ext]) => [ext, mime]),
);

// Public media endpoint: /uploads/<id>.<ext>. Platforms (Instagram, TikTok, Facebook video)
// download media from this URL, so it must not require a login. Supports Range requests,
// which video fetchers commonly use.
export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  if (!/^m_[A-Za-z0-9_-]{8,40}\.[a-z0-9]{2,5}$/.test(name)) return new Response("Not found", { status: 404 });
  const ext = name.split(".").pop()!;
  const type = MIME_BY_EXT[ext];
  if (!type) return new Response("Not found", { status: 404 });
  const file = path.join(uploadsDir(), name);
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  };
  const range = req.headers.get("range");
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
  return new Response(stream, { headers: { ...headers, "Content-Length": String(size) } });
}

export async function HEAD(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const res = await GET(req, ctx);
  // GET opened a file read stream; cancel it or every HEAD leaks a file descriptor.
  await res.body?.cancel().catch(() => {});
  return new Response(null, { status: res.status, headers: res.headers });
}
