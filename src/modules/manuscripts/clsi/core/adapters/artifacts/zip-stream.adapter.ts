/**
 * modules/manuscripts/clsi/core/adapters/artifacts/zip-stream.adapter.ts
 * Lightweight, zero-dependency PKZIP 2.0 streaming generator utilizing Node.js built-in zlib.
 * Matches Overleaf CLSI project artifact packaging semantics with streaming backpressure.
 */

import * as fsp from 'fs/promises';
import { Readable } from 'stream';
import {
  buildPkZipBuffer,
  createPkZipStream,
  PkZipEntry,
  sanitizePkZipPath,
} from '@/modules/manuscripts/shared/zip/pkzip-builder.util';

export interface ZipFileEntry {
  path: string;
  data: string | Buffer;
  date?: Date;
}

export interface ZipDiskEntry {
  fullPath: string;
  relPath: string;
  date?: Date;
}

export type ZipEntry = ZipFileEntry | ZipDiskEntry;

function isDiskEntry(entry: ZipEntry): entry is ZipDiskEntry {
  return 'fullPath' in entry && 'relPath' in entry;
}

export function sanitizeZipPath(relPath: string): string {
  return sanitizePkZipPath(relPath);
}

/**
 * Creates a streamable PKZIP 2.0 Readable stream from disk files.
 * Streams files one-by-one with backpressure, avoiding massive memory spikes
 * for large PDFs and graphic assets.
 */
export function createZipStreamFromDisk(files: ZipDiskEntry[]): Readable {
  return createZipStream(files);
}

/**
 * Universal PKZIP 2.0 stream generator supporting both in-memory entries and disk files.
 * Emits chunks asynchronously respecting Node.js stream backpressure.
 */
export function createZipStream(entries: ZipEntry[]): Readable {
  const pkEntries: PkZipEntry[] = entries.map((entry) => {
    if (isDiskEntry(entry)) {
      return {
        path: entry.relPath,
        date: entry.date,
        getData: async () => {
          try {
            return await fsp.readFile(entry.fullPath);
          } catch {
            // Skip unreadable or concurrently deleted files
            return null;
          }
        },
      };
    }
    return {
      path: entry.path,
      data: entry.data,
      date: entry.date,
    };
  });

  return createPkZipStream(pkEntries);
}

/**
 * Synchronously build a full ZIP Buffer in memory.
 * Preserved for backward compatibility and fast small tests.
 */
export function buildZipArchive(entries: ZipFileEntry[]): Buffer {
  return buildPkZipBuffer(entries);
}
