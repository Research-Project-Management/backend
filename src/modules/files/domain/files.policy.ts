import * as path from 'path';
import { BadRequestException } from '@nestjs/common';

export const BLOCKED_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.sh',
  '.bash',
  '.php',
  '.phtml',
  '.php3',
  '.php4',
  '.php5',
  '.php7',
  '.jsp',
  '.jspx',
  '.asp',
  '.aspx',
  '.cgi',
  '.pl',
  '.py',
  '.rb',
  '.vbs',
  '.js',
  '.mjs',
  '.html',
  '.htm',
  '.xhtml',
  '.dll',
  '.so',
  '.dylib',
  '.com',
  '.scr',
  '.ps1',
  '.msi',
]);

export function isBlockedExtension(filename: string): boolean {
  if (!filename) return true;
  const ext = path.extname(filename).toLowerCase();
  return BLOCKED_EXTENSIONS.has(ext);
}

export function sanitizeFilename(filename: string): string {
  if (!filename) return 'unnamed-file';
  const basename = path.basename(filename);
  const sanitized = basename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'unnamed-file';
}

export function validateMagicBytes(
  buffer: Buffer,
  mimeType?: string,
  filename?: string,
): void {
  if (filename && isBlockedExtension(filename)) {
    const ext = path.extname(filename);
    throw new BadRequestException(
      `File extension '${ext}' is strictly prohibited for security reasons`,
    );
  }

  if (!buffer || buffer.length === 0) {
    throw new BadRequestException('Uploaded file buffer is empty');
  }

  const normalizedMime = (mimeType || '').toLowerCase();
  const ext = (filename ? path.extname(filename) : '').toLowerCase();

  // 1. PDF Verification: Must start with '%PDF-' (0x25, 0x50, 0x44, 0x46, 0x2D)
  if (normalizedMime === 'application/pdf' || ext === '.pdf') {
    if (buffer.length < 5) {
      throw new BadRequestException('Invalid PDF file: buffer too short');
    }
    const isPdfMagic =
      buffer[0] === 0x25 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x44 &&
      buffer[3] === 0x46 &&
      buffer[4] === 0x2d;

    if (!isPdfMagic) {
      throw new BadRequestException(
        'File signature mismatch: Claimed PDF file does not have valid PDF magic bytes (%PDF-)',
      );
    }
    return;
  }

  // 2. PNG Verification: 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A
  if (normalizedMime === 'image/png' || ext === '.png') {
    if (buffer.length < 8) {
      throw new BadRequestException('Invalid PNG file: buffer too short');
    }
    const isPng =
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a;

    if (!isPng) {
      throw new BadRequestException(
        'File signature mismatch: Claimed PNG image does not have valid PNG magic bytes',
      );
    }
    return;
  }

  // 3. JPEG Verification: Must start with 0xFF, 0xD8, 0xFF
  if (
    normalizedMime === 'image/jpeg' ||
    normalizedMime === 'image/jpg' ||
    ext === '.jpg' ||
    ext === '.jpeg'
  ) {
    if (buffer.length < 3) {
      throw new BadRequestException('Invalid JPEG file: buffer too short');
    }
    const isJpeg =
      buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;

    if (!isJpeg) {
      throw new BadRequestException(
        'File signature mismatch: Claimed JPEG image does not have valid JPEG magic bytes',
      );
    }
    return;
  }

  // 4. WebP Verification: Starts with 'RIFF' and has 'WEBP' at bytes 8-11
  if (normalizedMime === 'image/webp' || ext === '.webp') {
    if (buffer.length < 12) {
      throw new BadRequestException('Invalid WebP file: buffer too short');
    }
    const isRiff =
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46;
    const isWebp =
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50;

    if (!isRiff || !isWebp) {
      throw new BadRequestException(
        'File signature mismatch: Claimed WebP image does not have valid RIFF/WEBP magic bytes',
      );
    }
    return;
  }

  // 5. Reject executable ELF / PE headers regardless of claimed type
  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    throw new BadRequestException(
      'Security violation: Windows executable (MZ header) detected and rejected',
    );
  }

  if (
    buffer.length >= 4 &&
    buffer[0] === 0x7f &&
    buffer[1] === 0x45 &&
    buffer[2] === 0x4c &&
    buffer[3] === 0x46
  ) {
    throw new BadRequestException(
      'Security violation: Linux executable (ELF header) detected and rejected',
    );
  }

  // 6. SVG comprehensive script and event handler inspection (Stored XSS prevention)
  if (normalizedMime === 'image/svg+xml' || ext === '.svg') {
    const scanWindow = buffer
      .slice(0, Math.min(buffer.length, 65536))
      .toString('utf8');
    if (
      /<script[\s>]/i.test(scanWindow) ||
      /javascript:/i.test(scanWindow) ||
      /data:text\/html/i.test(scanWindow) ||
      /on\w+\s*=/i.test(scanWindow) ||
      /<foreignObject[\s>]/i.test(scanWindow) ||
      /<iframe[\s>]/i.test(scanWindow) ||
      /<embed[\s>]/i.test(scanWindow) ||
      /<object[\s>]/i.test(scanWindow)
    ) {
      throw new BadRequestException(
        'Security violation: SVG contains potentially malicious active content (script, event handler, or foreignObject)',
      );
    }
  }
}

export function isDangerousInlineMime(mimeType?: string): boolean {
  if (!mimeType) return false;
  const lower = mimeType.toLowerCase();
  return (
    lower.includes('svg') ||
    lower.includes('html') ||
    lower.includes('xml') ||
    lower === 'application/xhtml+xml' ||
    lower.includes('javascript') ||
    lower.includes('ecmascript')
  );
}

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(id: string | null | undefined): id is string {
  return Boolean(id && UUID_REGEX.test(id));
}

export function cleanUuid(id: string | null | undefined): string | null {
  return isValidUuid(id) ? id : null;
}

export async function streamToBuffer(
  stream: AsyncIterable<Buffer | Uint8Array | string>,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.tex': 'application/x-tex',
  '.bib': 'application/x-bibtex',
};

/**
 * Infers MIME type from leading magic bytes first, then filename extension.
 */
export function inferMimeType(options: {
  filename?: string;
  headerBytes?: Buffer;
}): string {
  const buf = options.headerBytes;
  if (buf && buf.length >= 3) {
    if (
      buf.length >= 4 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    ) {
      return 'image/png';
    }
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return 'image/jpeg';
    }
    if (
      buf.length >= 4 &&
      buf[0] === 0x47 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x38
    ) {
      return 'image/gif';
    }
    if (
      buf.length >= 12 &&
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return 'image/webp';
    }
    if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === '%PDF') {
      return 'application/pdf';
    }
    if (
      buf.length >= 4 &&
      buf[0] === 0x50 &&
      buf[1] === 0x4b &&
      buf[2] === 0x03 &&
      buf[3] === 0x04
    ) {
      return 'application/zip';
    }
    const snippet = buf
      .subarray(0, Math.min(buf.length, 256))
      .toString('utf8')
      .trimStart()
      .toLowerCase();
    if (
      snippet.startsWith('<svg') ||
      (snippet.startsWith('<?xml') && snippet.includes('<svg'))
    ) {
      return 'image/svg+xml';
    }
  }

  if (options.filename) {
    const ext = path.extname(options.filename.split('?')[0]).toLowerCase();
    if (ext && MIME_BY_EXTENSION[ext]) {
      return MIME_BY_EXTENSION[ext];
    }
  }

  return 'application/octet-stream';
}

export function resolveTargetSpaceId(
  spaceId?: string | null,
  fallbackUserId?: string | null,
): string | null {
  const explicit = spaceId?.trim();
  if (explicit) return explicit;
  const fallback = fallbackUserId?.trim();
  return fallback || null;
}
