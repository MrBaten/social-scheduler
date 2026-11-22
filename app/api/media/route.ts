import { requireUser } from "@/lib/auth";
import { handle, HttpError } from "@/lib/api";
import { config } from "@/lib/config";
import { saveUpload, toMediaPublic } from "@/lib/media";

// Writes to the local filesystem; must run on Node.
export const runtime = "nodejs";
export const maxDuration = 300;

/** Allowance for multipart boundaries/headers on top of the file itself. */
const MULTIPART_OVERHEAD = 1024 * 1024;

export async function POST(request: Request) {
  return handle(async () => {
    const user = await requireUser();
    const limit = config.maxUploadBytes + MULTIPART_OVERHEAD;
    const tooLarge = () => new HttpError(413, `File too large (max ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB)`);
    const len = Number(request.headers.get("content-length") || 0);
    if (len > limit) throw tooLarge();
    if (!request.body) throw new HttpError(400, "Expected multipart/form-data with a 'file' field");

    // formData() buffers the whole body. Content-Length can be absent (chunked / HTTP/2 via the
    // proxy) or wrong, so also count bytes as they stream in and abort past the limit.
    let received = 0;
    let overLimit = false;
    const limited = request.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > limit) {
            overLimit = true;
            controller.error(new Error("upload too large"));
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    let form: FormData;
    try {
      form = await new Response(limited, {
        headers: { "content-type": request.headers.get("content-type") ?? "" },
      }).formData();
    } catch {
      if (overLimit) throw tooLarge();
      throw new HttpError(400, "Expected multipart/form-data with a 'file' field");
    }
    const file = form.get("file");
    if (!file || typeof file === "string") throw new HttpError(400, "Missing 'file' field");
    const media = await saveUpload(user.id, file);
    return { media: toMediaPublic(media) };
  });
}
