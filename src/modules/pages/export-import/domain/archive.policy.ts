import {
  KNOWN_TEXT_EXTENSIONS,
  KNOWN_BINARY_EXTENSIONS,
} from '@/modules/pages/core/domain/text-extensions';
import {
  ArchiveFileLimitExceededException,
  ArchiveSizeExceededException,
  InvalidZipArchiveException,
} from './archive.errors';
import type { ArchiveEntryVo, EntryStorageType } from './archive.domain';

export { KNOWN_TEXT_EXTENSIONS, KNOWN_BINARY_EXTENSIONS };

export const MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_UNCOMPRESSED_PROJECT_BYTES = 500 * 1024 * 1024;
export const MAX_PROJECT_ENTRY_COUNT = 10_000;

export const ARXIV_ALLOWED_EXTENSIONS = new Set([
  'tex', 'ltx', 'rtex', 'sty', 'cls', 'bst', 'def', 'fd', 'cfg', 'clo',
  'bbx', 'cbx', 'bib', 'bbl', 'tikz', 'pgf', 'png', 'jpg', 'jpeg', 'pdf',
  'eps', 'ps', 'svg', 'csv', 'dat', 'txt',
]);

const ARXIV_FORBIDDEN_AUX_RE = /\.(aux|log|out|synctex\.gz|toc|lof|lot|fls|fdb_latexmk)$/i;
const UNSAFE_DRIVE_RE = /^[a-zA-Z]:/;
const UNSAFE_SYS_ROOT_RE = /^\/+(etc|var|usr|bin|sbin|proc|sys|dev|root|home|boot|lib)\b/i;
const PRIVATE_172_HOST_RE = /^172\.(1[6-9]|2\d|3[01])\./;
const UTF8_FATAL_DECODER = new TextDecoder('utf-8', { fatal: true });

export function isArxivAllowed(relPath: string): boolean {
  const clean = relPath.trim().toLowerCase();
  const slashIdx = clean.lastIndexOf('/');
  const base = slashIdx === -1 ? clean : clean.slice(slashIdx + 1);
  if (!base || base.charCodeAt(0) === 46 || base.startsWith('__macosx')) {
    return false;
  }
  if (ARXIV_FORBIDDEN_AUX_RE.test(base)) {
    return false;
  }
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx === -1) return false;
  return ARXIV_ALLOWED_EXTENSIONS.has(base.slice(dotIdx + 1));
}

export interface ExportProfile {
  readonly cleanArxiv: boolean;
  readonly includeBbl: boolean;
  readonly includePdf: boolean;
  shouldInclude(relPath: string): boolean;
  formatArchiveName(projectName?: string): string;
}

export function resolveExportProfile(options?: {
  cleanArxiv?: boolean;
  includePdf?: boolean;
  mode?: string;
}): ExportProfile {
  const cleanArxiv =
    Boolean(options?.cleanArxiv) || options?.mode?.toLowerCase() === 'arxiv';

  if (cleanArxiv) {
    return {
      cleanArxiv: true,
      includeBbl: true,
      includePdf: false,
      shouldInclude: (relPath) => Boolean(relPath) && isArxivAllowed(relPath),
      formatArchiveName: (projectName) => {
        const base = projectName || 'manuscript';
        return base.startsWith('arxiv-') ? base : `arxiv-${base}`;
      },
    };
  }

  return {
    cleanArxiv: false,
    includeBbl: false,
    includePdf: Boolean(options?.includePdf),
    shouldInclude: (relPath) => Boolean(relPath),
    formatArchiveName: (projectName) => projectName || 'manuscript',
  };
}

export function isUnsafeArchivePath(normalizedPath: string): boolean {
  if (
    UNSAFE_DRIVE_RE.test(normalizedPath) ||
    UNSAFE_SYS_ROOT_RE.test(normalizedPath)
  ) {
    return true;
  }
  const segments = normalizedPath.split('/');
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === '..') return true;
  }
  return false;
}

export function isIgnoredSystemArtifactPath(entryPath: string): boolean {
  return (
    entryPath.startsWith('__MACOSX/') ||
    entryPath.includes('/__MACOSX/') ||
    entryPath.endsWith('.DS_Store') ||
    entryPath.endsWith('/.DS_Store') ||
    entryPath.endsWith('Thumbs.db') ||
    entryPath.endsWith('/Thumbs.db') ||
    entryPath.startsWith('.git/') ||
    entryPath.includes('/.git/')
  );
}

export function classifyEntryStorageType(
  entryPath: string,
  data: Buffer,
  isDirectory: boolean,
): EntryStorageType {
  if (isDirectory) return 'doc';

  const lastDot = entryPath.lastIndexOf('.');
  if (lastDot !== -1) {
    const ext = entryPath.slice(lastDot).toLowerCase();
    if (KNOWN_BINARY_EXTENSIONS.has(ext)) return 'file';
    if (KNOWN_TEXT_EXTENSIONS.has(ext)) return 'doc';
  }

  if (data.length <= 2 * 1024 * 1024 && isUtf8Buffer(data)) {
    return 'doc';
  }

  return 'file';
}

function isUtf8Buffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  const sampleSize = Math.min(buffer.length, 1024);
  for (let i = 0; i < sampleSize; i++) {
    if (buffer[i] === 0) return false;
  }
  try {
    UTF8_FATAL_DECODER.decode(buffer.subarray(0, sampleSize));
    return true;
  } catch {
    return false;
  }
}

export function validateExtractedArchiveEntries(
  entries: ArchiveEntryVo[],
  maxFiles = 2000,
): ArchiveEntryVo[] {
  if (entries.length === 0) {
    throw new InvalidZipArchiveException(
      'Provided ZIP archive contains no usable file entries.',
    );
  }
  if (entries.length > maxFiles) {
    throw new ArchiveFileLimitExceededException(maxFiles);
  }

  let totalBytes = 0;
  for (let i = 0; i < entries.length; i++) {
    const size = entries[i].sizeBytes;
    if (size > MAX_SINGLE_FILE_BYTES) {
      throw new ArchiveSizeExceededException(size, MAX_SINGLE_FILE_BYTES);
    }
    totalBytes += size;
    if (totalBytes > MAX_UNCOMPRESSED_PROJECT_BYTES) {
      throw new ArchiveSizeExceededException(
        totalBytes,
        MAX_UNCOMPRESSED_PROJECT_BYTES,
      );
    }
  }

  return entries;
}

export function isBlockedSsrfUrl(rawUrl: string): {
  parsed: URL | null;
  reason?: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { parsed: null, reason: 'Invalid URL format.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      parsed: null,
      reason: 'Only http:// and https:// URLs are allowed.',
    };
  }
  const host = parsed.hostname.toLowerCase();
  const isPrivate =
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0.0.0.0' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    PRIVATE_172_HOST_RE.test(host);
  if (isPrivate) {
    return {
      parsed: null,
      reason: 'Private or loopback URLs are not permitted.',
    };
  }
  return { parsed };
}
