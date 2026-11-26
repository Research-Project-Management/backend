import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  isDangerousInlineMime,
  sanitizeFilename,
} from '../domain/files.policy';

export const MAX_DIRECT_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_PUBLIC_UPLOAD_BYTES = 10 * 1024 * 1024;

interface MultipartStreamRequest extends Omit<
  FastifyRequest,
  'isMultipart' | 'parts'
> {
  isMultipart?: () => boolean;
  parts: () => AsyncIterable<{
    type: string;
    fieldname: string;
    filename?: string;
    mimetype?: string;
    value?: unknown;
    file?: AsyncIterable<Buffer>;
  }>;
}

export function applyBinaryHeaders(
  res: FastifyReply,
  options: {
    mimeType: string;
    filename: string;
    isDownload: boolean;
    contentLength?: number;
    contentRange?: string;
    etag?: string;
    cacheControl: string;
    varyHeader: string;
  },
): void {
  const cleanName = sanitizeFilename(options.filename);
  const isDangerous = isDangerousInlineMime(options.mimeType);
  const disposition =
    isDangerous || options.isDownload ? 'attachment' : 'inline';

  res.header('Content-Type', options.mimeType);
  if (options.contentLength !== undefined) {
    res.header('Content-Length', options.contentLength);
  }
  res.header('Accept-Ranges', 'bytes');
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'SAMEORIGIN');
  res.header('Cache-Control', options.cacheControl);
  res.header('Vary', options.varyHeader);
  if (options.etag) {
    res.header('ETag', options.etag);
  }
  if (options.contentRange) {
    res.header('Content-Range', options.contentRange);
  }
  if (isDangerous) {
    res.header('Content-Security-Policy', "default-src 'none'; sandbox");
  }

  const encoded = encodeURIComponent(cleanName);
  res.header(
    'Content-Disposition',
    `${disposition}; filename="${cleanName.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encoded}`,
  );
}

export async function extractMultipartSingleFile(
  req: FastifyRequest,
  maxBytes: number,
): Promise<{
  buffer: Buffer;
  filename: string;
  mimeType: string;
  fields: Record<string, string>;
}> {
  const multipartReq = req as unknown as MultipartStreamRequest;
  if (
    typeof multipartReq.isMultipart !== 'function' ||
    !multipartReq.isMultipart()
  ) {
    throw new BadRequestException('Content-Type must be multipart/form-data');
  }

  let buffer: Buffer | undefined;
  let filename = 'uploaded-file';
  let mimeType = 'application/octet-stream';
  const fields: Record<string, string> = {};

  for await (const part of multipartReq.parts()) {
    if (part.type === 'file') {
      filename = part.filename || filename;
      mimeType = part.mimetype || mimeType;
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      if (part.file) {
        for await (const chunk of part.file) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buf.length;
          if (totalBytes > maxBytes) {
            throw new PayloadTooLargeException(
              `Direct upload exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`,
            );
          }
          chunks.push(buf);
        }
      }
      buffer = Buffer.concat(chunks);
    } else if (part.fieldname && part.value !== undefined) {
      fields[part.fieldname] = String(part.value);
    }
  }

  if (!buffer) {
    throw new BadRequestException('No file uploaded');
  }

  const chosenName =
    filename && filename !== 'blob'
      ? filename
      : fields.fileName || fields.filename || fields.name || 'uploaded-file';

  return { buffer, filename: chosenName, mimeType, fields };
}
