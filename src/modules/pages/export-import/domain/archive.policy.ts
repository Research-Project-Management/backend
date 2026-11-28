import {
  KNOWN_TEXT_EXTENSIONS,
  KNOWN_BINARY_EXTENSIONS,
} from '@/modules/pages/core';
import {
  ArchiveFileLimitExceededException,
  ArchiveSizeExceededException,
  InvalidZipArchiveException,
} from './archive.errors';
import type { ArchiveEntryVo, EntryStorageType } from './archive.domain';

export const MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_UNCOMPRESSED_PROJECT_BYTES = 500 * 1024 * 1024;
export const MAX_PROJECT_ENTRY_COUNT = 10_000;

export const ARXIV_ALLOWED_EXTENSIONS = new Set([
  'tex',
  'ltx',
  'rtex',
  'sty',
  'cls',
  'bst',
  'def',
  'fd',
  'cfg',
  'clo',
  'bbx',
  'cbx',
  'bib',
  'bbl',
  'tikz',
  'pgf',
  'png',
  'jpg',
  'jpeg',
  'pdf',
  'eps',
  'ps',
  'svg',
  'csv',
  'dat',
  'txt',
]);

const ARXIV_FORBIDDEN_AUX_RE =
  /\.(aux|log|out|synctex\.gz|toc|lof|lot|fls|fdb_latexmk)$/i;
const UNSAFE_DRIVE_RE = /^[a-zA-Z]:/;
const UNSAFE_SYS_ROOT_RE =
  /^\/+(etc|var|usr|bin|sbin|proc|sys|dev|root|home|boot|lib)\b/i;
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
    !normalizedPath ||
    normalizedPath.includes('\0') ||
    normalizedPath.startsWith('//') ||
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

function decodeMappedIpv4(ip: string): string {
  if (!ip.startsWith('::ffff:')) return ip;
  const tail = ip.slice(7);
  if (tail.includes('.')) return tail;
  const parts = tail.split(':');
  if (parts.length === 2) {
    const hi = Number.parseInt(parts[0], 16);
    const lo = Number.parseInt(parts[1], 16);
    if (
      Number.isFinite(hi) &&
      Number.isFinite(lo) &&
      hi >= 0 &&
      hi <= 0xffff &&
      lo >= 0 &&
      lo <= 0xffff
    ) {
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return tail;
}

function isPrivateIpv4(v4: string): boolean {
  const octets = v4.split('.');
  if (octets.length !== 4) return false;
  const nums = octets.map((o) => (/^\d{1,3}$/.test(o) ? Number(o) : -1));
  if (nums.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = nums;
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) || // 169.254.0.0/16 Link-local / Cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) // 192.168.0.0/16
  );
}

export function isPrivateIpAddress(rawIp: string): boolean {
  const ip = rawIp
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!ip) return true;
  if (ip === '::1' || ip === '::' || /^fe[89ab][0-9a-f]:/.test(ip)) {
    return true;
  }
  if (ip.startsWith('fc') || ip.startsWith('fd')) {
    return true;
  }
  const v4 = decodeMappedIpv4(ip);
  if (isPrivateIpv4(v4)) {
    return true;
  }
  return v4 === '::1' || v4 === '::' || PRIVATE_172_HOST_RE.test(v4);
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
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isPrivate =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    /^\d+$/.test(host) || // Reject decimal IP encoding (e.g. 2130706433)
    /^0x[0-9a-f]+$/i.test(host) || // Reject hex IP encoding
    isPrivateIpAddress(host);
  if (isPrivate) {
    return {
      parsed: null,
      reason: 'Private or loopback URLs are not permitted.',
    };
  }
  return { parsed };
}
