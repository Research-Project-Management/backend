/**
 * modules/pages/core/utils/zip-builder.ts
 * Standard ZIP packing and streaming utilities powered by `fflate`
 * (replaces hand-rolled PKZIP binary header/EOCD packing).
 */

import * as zlib from 'zlib';
import { PassThrough, Readable } from 'stream';
import { Zip, ZipDeflate, ZipPassThrough, zipSync, type Zippable } from 'fflate';

/**
 * Computes the unsigned 32-bit CRC-32 checksum of a buffer or string.
 */
export function crc32(data: Buffer | string): number {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  return zlib.crc32(buf) >>> 0;
}

/**
 * Normalizes a relative archive path and strips path-traversal sequences.
 */
function sanitizeZipPath(relPath: string): string {
  return relPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && !/^\.+$/.test(segment))
    .join('/');
}

export interface ZipEntry {
  path: string;
  data?: Buffer | string;
  getData?: () => Promise<Buffer | string | null>;
  date?: Date;
}

function toUint8Array(data: Buffer | string | undefined): Uint8Array {
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  const buf = Buffer.from(data || '', 'utf8');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Synchronously builds a compliant ZIP binary Buffer from in-memory entries via `fflate`.
 */
export function buildZipBuffer(entries: ZipEntry[]): Buffer {
  const archive: Zippable = {};

  for (const entry of entries) {
    const cleanPath = sanitizeZipPath(entry.path);
    if (!cleanPath) continue;

    const bytes = toUint8Array(entry.data);
    archive[cleanPath] = [
      bytes,
      {
        level: bytes.byteLength === 0 ? 0 : 6,
        ...(entry.date ? { mtime: entry.date } : {}),
      },
    ];
  }

  return Buffer.from(zipSync(archive));
}

/**
 * Creates a streaming ZIP Readable stream powered by `fflate.Zip`.
 * If an entry's `getData()` resolves to `null`, that entry is skipped gracefully.
 */
export function createZipStream(entries: ZipEntry[]): Readable {
  const output = new PassThrough();

  const zipper = new Zip((err, chunk, final) => {
    if (err) {
      output.destroy(err);
      return;
    }
    if (chunk && chunk.byteLength > 0) {
      output.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
    if (final) {
      output.end();
    }
  });

  void (async () => {
    try {
      for (const entry of entries) {
        const cleanPath = sanitizeZipPath(entry.path);
        if (!cleanPath) continue;

        let resolved: Buffer | string | null | undefined;
        if (entry.getData) {
          resolved = await entry.getData();
          if (resolved === null) continue;
        } else {
          resolved = entry.data;
        }

        const bytes = toUint8Array(resolved);
        const fileStream =
          bytes.byteLength === 0
            ? new ZipPassThrough(cleanPath)
            : new ZipDeflate(cleanPath, { level: 6 });

        if (entry.date) {
          fileStream.mtime = entry.date;
        }

        zipper.add(fileStream);
        fileStream.push(bytes, true);
      }

      zipper.end();
    } catch (err) {
      output.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return output;
}

/** @deprecated Use ZipEntry, sanitizeZipPath, buildZipBuffer, createZipStream */
export {
  type ZipEntry as PkZipEntry,
  sanitizeZipPath as sanitizePkZipPath,
  buildZipBuffer as buildPkZipBuffer,
  createZipStream as createPkZipStream,
};
