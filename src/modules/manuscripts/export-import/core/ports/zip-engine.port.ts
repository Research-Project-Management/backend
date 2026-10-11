/**
 * export-import/core/ports/zip-engine.port.ts
 * Outbound Port (SPI) for creating and extracting PKZIP 2.0 binary archives.
 */

import { Readable } from 'node:stream';
import { ArchiveEntryVo } from '../domain/value-objects/archive-entry.vo';

export interface RawZipEntryInput {
  path: string;
  data?: Buffer | string;
  getData?: () => Promise<Buffer | string>;
  date?: Date;
}

export abstract class IZipEnginePort {
  /**
   * Packages file entries into an in-memory PKZIP 2.0 buffer.
   */
  abstract buildZip(entries: RawZipEntryInput[]): Buffer;

  /**
   * Encodes entries into a streaming PKZIP 2.0 Readable with backpressure.
   */
  abstract createZipStream(entries: RawZipEntryInput[]): Readable;

  /**
   * Parses and uncompresses a PKZIP buffer into an array of sanitized ArchiveEntryVo items.
   * Throws ZipSlipSecurityException or InvalidZipArchiveException if malicious or corrupted.
   */
  abstract extractZip(zipBuffer: Buffer): ArchiveEntryVo[];
}
