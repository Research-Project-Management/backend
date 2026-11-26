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

export function isArxivAllowed(relPath: string): boolean {
  const clean = relPath.trim().toLowerCase();
  const base = clean.split('/').pop() || '';
  if (base.startsWith('.') || base.startsWith('__macosx')) return false;
  if (/\.(aux|log|out|synctex\.gz|toc|lof|lot|fls|fdb_latexmk)$/i.test(base)) {
    return false;
  }
  const ext = base.split('.').pop() || '';
  return ARXIV_ALLOWED_EXTENSIONS.has(ext);
}

/**
 * GoF Strategy Pattern: Polymorphic Export Profile (`StandardExportProfile` vs `ArxivExportProfile`).
 * Eliminates `if (cleanArxiv)` branching across services and collectors.
 */
export interface IExportProfileStrategy {
  readonly mode: 'standard' | 'arxiv';
  readonly cleanArxiv: boolean;
  readonly includeBblArtifact: boolean;
  shouldIncludeEntry(relPath: string): boolean;
  shouldIncludeCompiledPdf(requested?: boolean): boolean;
  formatArchiveName(projectName?: string): string;
}

export class StandardExportProfile implements IExportProfileStrategy {
  public readonly mode = 'standard' as const;
  public readonly cleanArxiv = false;
  public readonly includeBblArtifact = false;

  public shouldIncludeEntry(relPath: string): boolean {
    return Boolean(relPath);
  }

  public shouldIncludeCompiledPdf(requested = false): boolean {
    return requested;
  }

  public formatArchiveName(projectName?: string): string {
    return projectName || 'manuscript';
  }
}

export class ArxivExportProfile implements IExportProfileStrategy {
  public readonly mode = 'arxiv' as const;
  public readonly cleanArxiv = true;
  public readonly includeBblArtifact = true;

  public shouldIncludeEntry(relPath: string): boolean {
    return Boolean(relPath) && isArxivAllowed(relPath);
  }

  public shouldIncludeCompiledPdf(): boolean {
    return false;
  }

  public formatArchiveName(projectName?: string): string {
    const baseName = projectName || 'manuscript';
    return baseName.startsWith('arxiv-') ? baseName : `arxiv-${baseName}`;
  }
}

const STANDARD_EXPORT_PROFILE = new StandardExportProfile();
const ARXIV_EXPORT_PROFILE = new ArxivExportProfile();

export function resolveExportProfile(options?: {
  cleanArxiv?: boolean;
  mode?: string;
}): IExportProfileStrategy {
  const isArxiv =
    Boolean(options?.cleanArxiv) || options?.mode?.toLowerCase() === 'arxiv';
  return isArxiv ? ARXIV_EXPORT_PROFILE : STANDARD_EXPORT_PROFILE;
}

export function isUnsafeArchivePath(normalizedPath: string): boolean {
  const segments = normalizedPath.split('/');
  return (
    segments.includes('..') ||
    /^[a-zA-Z]:/.test(normalizedPath) ||
    /^\/+(etc|var|usr|bin|sbin|proc|sys|dev|root|home|boot|lib)\b/i.test(
      normalizedPath,
    )
  );
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
    new TextDecoder('utf-8', { fatal: true }).decode(
      buffer.subarray(0, sampleSize),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * GoF Chain of Responsibility Pattern: Sequential archive safety & quota validators.
 */
export abstract class ArchiveValidationHandler {
  private nextHandler: ArchiveValidationHandler | null = null;

  public setNext(handler: ArchiveValidationHandler): ArchiveValidationHandler {
    this.nextHandler = handler;
    return handler;
  }

  public validate(entries: ArchiveEntryVo[], maxFiles: number): void {
    this.check(entries, maxFiles);
    this.nextHandler?.validate(entries, maxFiles);
  }

  protected abstract check(entries: ArchiveEntryVo[], maxFiles: number): void;
}

class NonEmptyArchiveValidator extends ArchiveValidationHandler {
  protected check(entries: ArchiveEntryVo[]): void {
    if (entries.length === 0) {
      throw new InvalidZipArchiveException(
        'Provided ZIP archive contains no usable file entries.',
      );
    }
  }
}

class EntryCountQuotaValidator extends ArchiveValidationHandler {
  protected check(entries: ArchiveEntryVo[], maxFiles: number): void {
    if (entries.length > maxFiles) {
      throw new ArchiveFileLimitExceededException(maxFiles);
    }
  }
}

class UncompressedSizeQuotaValidator extends ArchiveValidationHandler {
  protected check(entries: ArchiveEntryVo[]): void {
    let totalBytes = 0;
    for (const entry of entries) {
      if (entry.sizeBytes > MAX_SINGLE_FILE_BYTES) {
        throw new ArchiveSizeExceededException(
          entry.sizeBytes,
          MAX_SINGLE_FILE_BYTES,
        );
      }
      totalBytes += entry.sizeBytes;
      if (totalBytes > MAX_UNCOMPRESSED_PROJECT_BYTES) {
        throw new ArchiveSizeExceededException(
          totalBytes,
          MAX_UNCOMPRESSED_PROJECT_BYTES,
        );
      }
    }
  }
}

function buildArchiveValidationChain(): ArchiveValidationHandler {
  const head = new NonEmptyArchiveValidator();
  head
    .setNext(new EntryCountQuotaValidator())
    .setNext(new UncompressedSizeQuotaValidator());
  return head;
}

const DEFAULT_ARCHIVE_VALIDATOR = buildArchiveValidationChain();

export function validateExtractedArchiveEntries(
  entries: ArchiveEntryVo[],
  maxFiles = 2000,
): ArchiveEntryVo[] {
  DEFAULT_ARCHIVE_VALIDATOR.validate(entries, maxFiles);
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
    host === '0.0.0.0' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (isPrivate) {
    return {
      parsed: null,
      reason: 'Private or loopback URLs are not permitted.',
    };
  }
  return { parsed };
}
