import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { getDb, newId, nowIso } from "./db";
import { config } from "./config";
import { HttpError } from "./api";
import type { MediaItem, MediaRow } from "./types";

// Local-disk media storage for the demo. Files go to data/uploads/<id>.<ext> (UPLOADS_DIR) and are
// served by app/uploads/[name]/route.ts at /uploads/<id>.<ext>, so Instagram/TikTok can fetch them
// via PUBLIC_MEDIA_BASE_URL. (Files written into public/ after `next build` are NOT served by
// `next start`, hence the route handler.) Ids are random, so URLs are unguessable but public:
// platforms must be able to download them without a login.
// Production: swap saveUpload for Supabase Storage / S3 and keep the same MediaRow shape.

export const ALLOWED_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

export function uploadsDir(): string {
  if (process.env.UPLOADS_DIR) return process.env.UPLOADS_DIR;
  // Same volume fallback as lib/db.ts (Railway), so uploads survive redeploys.
  const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (vol) return path.join(/*turbopackIgnore: true*/ vol, "uploads");
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "uploads");
}

export function mediaKind(mime: string): "image" | "video" {
  return mime.startsWith("video/") ? "video" : "image";
}

/** Safe-for-browser media view returned by POST /api/media. */
export interface MediaPublic {
  id: string;
  public_url: string;
  mime_type: string;
  filename: string;
  size_bytes: number;
}

export function toMediaPublic(m: MediaRow): MediaPublic {
  return { id: m.id, public_url: m.public_url, mime_type: m.mime_type, filename: m.filename, size_bytes: m.size_bytes };
}

function cleanFilename(name: string): string {
  const base = path.basename(name || "upload").replace(/[^\w.\- ]+/g, "_").trim();
  return (base || "upload").slice(0, 200);
}

/**
 * Persist an uploaded Web `File` (from request.formData()) for `userId`.
 * Throws HttpError 400 (bad type / empty) or 413 (too large).
 */
export async function saveUpload(userId: string, file: File): Promise<MediaRow> {
  const mime = (file.type || "").toLowerCase();
  const ext = ALLOWED_MIME[mime];
  if (!ext) {
    throw new HttpError(400, `Unsupported file type "${mime || "unknown"}". Allowed: ${Object.keys(ALLOWED_MIME).join(", ")}`);
  }
  if (file.size <= 0) throw new HttpError(400, "File is empty");
  if (file.size > config.maxUploadBytes) {
    throw new HttpError(413, `File too large (max ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB)`);
  }

  const id = newId("m_");
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });
  const diskName = `${id}.${ext}`;
  const absPath = path.join(/*turbopackIgnore: true*/ dir, diskName);

  // Stream to disk instead of buffering the whole (possibly 200 MB) video in memory.
  try {
    await pipeline(Readable.fromWeb(file.stream() as unknown as NodeWebReadableStream), fs.createWriteStream(absPath));
  } catch (err) {
    fs.rmSync(absPath, { force: true });
    throw err;
  }

  const row: MediaRow = {
    id,
    user_id: userId,
    filename: cleanFilename(file.name),
    mime_type: mime,
    size_bytes: fs.statSync(/*turbopackIgnore: true*/ absPath).size,
    path: absPath,
    public_url: `${config.publicMediaBaseUrl}/uploads/${diskName}`,
    created_at: nowIso(),
  };
  getDb()
    .prepare(
      `INSERT INTO media (id, user_id, filename, mime_type, size_bytes, path, public_url, created_at)
       VALUES (@id, @user_id, @filename, @mime_type, @size_bytes, @path, @public_url, @created_at)`,
    )
    .run(row);
  return row;
}

function rowToItem(r: MediaRow): MediaItem {
  return {
    id: r.id,
    mime_type: r.mime_type,
    kind: mediaKind(r.mime_type),
    path: r.path,
    public_url: r.public_url,
    size_bytes: r.size_bytes,
    filename: r.filename,
  };
}

/**
 * Media items owned by `userId`, in the order of `ids`. Unknown / foreign ids are skipped,
 * so callers compare lengths to detect bad ids.
 */
export function getMediaItems(userId: string, ids: string[]): MediaItem[] {
  if (ids.length === 0) return [];
  const stmt = getDb().prepare("SELECT * FROM media WHERE id = ? AND user_id = ?");
  const out: MediaItem[] = [];
  for (const id of ids) {
    const r = stmt.get(id, userId) as MediaRow | undefined;
    if (r) out.push(rowToItem(r));
  }
  return out;
}

/** Media attached to a post, ordered by position. */
export function getPostMediaItems(postId: string): MediaItem[] {
  const rows = getDb()
    .prepare(
      `SELECT m.* FROM post_media pm JOIN media m ON m.id = pm.media_id
       WHERE pm.post_id = ? ORDER BY pm.position`,
    )
    .all(postId) as MediaRow[];
  return rows.map(rowToItem);
}
