import { GetObjectCommand } from "@aws-sdk/client-s3";
import { AppError } from "../../../lib/AppError.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the R2 object key from various fileUrl formats:
 *   - `/api/files/<key>`
 *   - `r2://<bucket>/<key>`
 *   - bare key (no protocol, no leading slash)
 * Returns `null` when the URL is a regular HTTP(S) link.
 */
const extractR2Key = (fileUrl) => {
  if (!fileUrl || typeof fileUrl !== "string") return null;

  const trimmed = fileUrl.trim();

  // Proxy-style URL: /api/files/<key>
  const proxyMatch = trimmed.match(/\/api\/files\/([^?#]+)/);
  if (proxyMatch?.[1]) return decodeURIComponent(proxyMatch[1]);

  // r2:// scheme
  if (trimmed.startsWith("r2://")) {
    const [, ...keyParts] = trimmed.slice("r2://".length).split("/");
    return keyParts.join("/") || null;
  }

  // Bare key (no protocol, no leading slash)
  if (!trimmed.startsWith("http") && !trimmed.startsWith("/")) {
    return trimmed;
  }

  return null;
};

const streamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

// ── Service ──────────────────────────────────────────────────────────────────

/**
 * Shared service for fetching file contents as a Buffer from R2 or external URLs.
 * Any context that needs raw file bytes (library/paper, manuscript, intelligence, etc.)
 * should inject this instead of implementing its own R2 logic.
 */
export class FileBufferService {
  constructor({ r2 }) {
    this.r2 = r2;
  }

  /**
   * Fetch file content as a Buffer.
   * Tries R2 first (if the URL matches an R2 key pattern), otherwise falls
   * back to a plain HTTP fetch.
   */
  async fetchBuffer(fileUrl) {
    const r2Key = extractR2Key(fileUrl);

    if (r2Key) {
      try {
        const response = await this.r2.send(
          new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: r2Key,
          }),
        );
        return streamToBuffer(response.Body);
      } catch (err) {
        throw new AppError(`R2 fetch failed for key "${r2Key}": ${err.message}`, 502);
      }
    }

    // External URL
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new AppError(`File fetch failed: ${response.status}`, 502);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}
