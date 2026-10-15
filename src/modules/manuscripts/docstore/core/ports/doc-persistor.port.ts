/**
 * modules/manuscripts/docstore/core/ports/doc-persistor.port.ts
 * Contract for Cold Tier Object Storage (S3 / MinIO).
 * Matches Overleaf PersistorManager / @overleaf/object-persistor semantics.
 */

import { Readable } from 'stream';
import { DocRanges } from '@/modules/manuscripts/docstore/core/domain/doc-range.vo';

export interface PersistArchivePayload {
  lines: string[];
  ranges?: DocRanges | Record<string, unknown>;
  schema_v: number;
}

export abstract class IDocPersistor {
  abstract sendStream(
    key: string,
    stream: Readable,
    options?: { sourceMd5?: string },
  ): Promise<void>;

  abstract getObjectStream(key: string): Promise<Readable>;

  abstract getObjectMd5Hash(key: string): Promise<string>;

  abstract deleteObject(key: string): Promise<void>;
}
