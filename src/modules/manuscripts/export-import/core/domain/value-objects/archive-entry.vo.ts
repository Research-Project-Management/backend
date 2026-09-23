/**
 * export-import/core/domain/value-objects/archive-entry.vo.ts
 * Value Object modeling an individual file or directory entry inside a ZIP archive.
 * Implements Overleaf-parity path sanitization and Zip Slip vulnerability defense.
 */

import { ZipSlipSecurityException } from '../exceptions/zip-slip-security.exception';

export type EntryStorageType = 'doc' | 'file';

export const KNOWN_TEXT_EXTENSIONS = new Set([
  '.tex',
  '.bib',
  '.cls',
  '.sty',
  '.bbl',
  '.bst',
  '.txt',
  '.md',
  '.latex',
  '.dtx',
  '.ins',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.xml',
  '.lua',
  '.py',
  '.sh',
  '.gitignore',
  '.latexmkrc',
]);

export const KNOWN_BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.tiff',
  '.webp',
  '.ico',
  '.pdf',
  '.eps',
  '.ai',
  '.psd',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  '.mp4',
  '.webm',
  '.mp3',
  '.wav',
  '.ogg',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
]);

export interface ArchiveEntryProps {
  path: string;
  data: Buffer;
  isDirectory?: boolean;
}

export class ArchiveEntryVo {
  public readonly path: string;
  public readonly data: Buffer;
  public readonly isDirectory: boolean;
  public readonly sizeBytes: number;

  private constructor(path: string, data: Buffer, isDirectory: boolean) {
    this.path = path;
    this.data = data;
    this.isDirectory = isDirectory;
    this.sizeBytes = data.length;
  }

  public static create(rawPath: string, data: Buffer = Buffer.alloc(0), isDirectory = false): ArchiveEntryVo {
    // 1. Normalize POSIX path separators
    const normalized = rawPath.replace(/\\/g, '/');

    // 2. Strict Zip Slip Vulnerability Guard (Overleaf Parity)
    const segments = normalized.split('/');
    if (
      segments.includes('..') ||
      /^[a-zA-Z]:/.test(normalized) ||
      /^\/+(etc|var|usr|bin|sbin|proc|sys|dev|root|home|boot|lib)\b/i.test(normalized)
    ) {
      throw new ZipSlipSecurityException(rawPath);
    }

    // Remove leading slashes and dot prefixes like ./
    let clean = normalized.replace(/^(\.\/)+/, '').replace(/^\/+/, '');

    const isDir = isDirectory || clean.endsWith('/');
    const trimmedPath = clean.replace(/\/+$/, '');

    return new ArchiveEntryVo(trimmedPath, data, isDir);
  }

  /**
   * Overleaf Parity: Filters out macOS & Windows OS metadata artifacts
   */
  public isIgnoredSystemArtifact(): boolean {
    const p = this.path;
    return (
      p.startsWith('__MACOSX/') ||
      p.includes('/__MACOSX/') ||
      p.endsWith('.DS_Store') ||
      p.endsWith('/.DS_Store') ||
      p.endsWith('Thumbs.db') ||
      p.endsWith('/Thumbs.db') ||
      p.startsWith('.git/') ||
      p.includes('/.git/')
    );
  }

  /**
   * Determine whether this file should be stored in Docstore (text line array) or Filestore (binary CAS blob).
   */
  public getStorageType(): EntryStorageType {
    if (this.isDirectory) return 'doc';

    const lastDot = this.path.lastIndexOf('.');
    if (lastDot !== -1) {
      const ext = this.path.slice(lastDot).toLowerCase();
      if (KNOWN_BINARY_EXTENSIONS.has(ext)) {
        return 'file';
      }
      if (KNOWN_TEXT_EXTENSIONS.has(ext)) {
        return 'doc';
      }
    }

    // Heuristic: If size <= 2MB and contains valid UTF-8 without null bytes
    if (this.data.length <= 2 * 1024 * 1024) {
      if (this.isUtf8Text(this.data)) {
        return 'doc';
      }
    }

    return 'file';
  }

  private isUtf8Text(buffer: Buffer): boolean {
    if (buffer.length === 0) return true;
    // Check first 1024 bytes for binary null characters
    const sampleSize = Math.min(buffer.length, 1024);
    for (let i = 0; i < sampleSize; i++) {
      if (buffer[i] === 0) {
        return false;
      }
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, sampleSize));
      return true;
    } catch {
      return false;
    }
  }
}
