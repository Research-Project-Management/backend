/**
 * modules/pages/docstore/domain/doc.ports.ts
 * Repository and Cold Tier Object Storage contracts plus Prometheus metrics for Docstore.
 */

import { Readable } from 'stream';
import { Prisma } from '@prisma/client';
import { TextDoc } from './text-doc.entity';
import { DocRanges } from './doc-range';

export interface CreateDocData {
  id?: string;
  projectId: string;
  pageId?: string | null;
  path: string;
  lines: string[];
  version?: number;
  ranges?: DocRanges;
  hash?: string;
  tx?: Prisma.TransactionClient;
}

export interface UpdateDocData {
  lines: string[];
  version: number;
  ranges?: DocRanges;
  hash?: string;
  expectedRev?: number;
  currentDoc?: TextDoc;
}

export interface PatchDocData {
  deleted?: boolean;
  name?: string;
  path?: string;
  deletedAt?: Date | null;
  ranges?: DocRanges;
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

  isDurableStorageConfigured?(): boolean;
}

export interface DocstoreMetricsSummary {
  totalReads: number;
  totalWrites: number;
  totalBytesWritten: number;
  occConflicts: number;
  noopSkips: number;
}

export class DocstoreMetrics {
  private static totalReads = 0;
  private static totalWrites = 0;
  private static totalBytesWritten = 0;
  private static occConflicts = 0;
  private static noopSkips = 0;

  public static recordRead(): void {
    this.totalReads++;
  }

  public static recordWrite(byteSize: number): void {
    this.totalWrites++;
    this.totalBytesWritten += byteSize;
  }

  public static recordOccConflict(): void {
    this.occConflicts++;
  }

  public static recordNoopSkip(): void {
    this.noopSkips++;
  }

  public static getSummary(): DocstoreMetricsSummary {
    return {
      totalReads: this.totalReads,
      totalWrites: this.totalWrites,
      totalBytesWritten: this.totalBytesWritten,
      occConflicts: this.occConflicts,
      noopSkips: this.noopSkips,
    };
  }

  public static reset(): void {
    this.totalReads = 0;
    this.totalWrites = 0;
    this.totalBytesWritten = 0;
    this.occConflicts = 0;
    this.noopSkips = 0;
  }
}
