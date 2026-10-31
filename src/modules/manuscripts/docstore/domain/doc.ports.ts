/**
 * modules/manuscripts/docstore/domain/doc.ports.ts
 * Repository and Cold Tier Object Storage contracts plus Prometheus metrics for Docstore.
 */

import { Readable } from 'stream';
import { Prisma } from '@prisma/client';
import { TextDoc } from './text-doc.entity';
import { DocRanges } from './doc-range';

export interface CreateDocData {
  projectId: string;
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

export abstract class IDocRepository {
  abstract getDoc(projectId: string, docId: string): Promise<TextDoc | null>;
  abstract getDocById(docId: string): Promise<TextDoc | null>;
  abstract getDocByPath(
    projectId: string,
    path: string,
  ): Promise<TextDoc | null>;
  abstract getAllDocs(projectId: string): Promise<TextDoc[]>;
  abstract getAllDeletedDocs(projectId: string): Promise<TextDoc[]>;
  abstract createDoc(data: CreateDocData): Promise<TextDoc>;
  abstract updateDoc(
    projectId: string,
    docId: string,
    data: UpdateDocData,
  ): Promise<{ doc: TextDoc; modified: boolean }>;
  abstract patchDoc(
    projectId: string,
    docId: string,
    patch: PatchDocData,
  ): Promise<TextDoc>;
  abstract markAsArchived(
    projectId: string,
    docId: string,
    storageKey: string,
    rev: number,
    clearLines?: boolean,
  ): Promise<boolean>;
  abstract unarchiveDoc(
    projectId: string,
    docId: string,
    lines: string[],
    ranges?: DocRanges,
  ): Promise<TextDoc>;
  abstract destroyDoc(projectId: string, docId: string): Promise<boolean>;
  abstract destroyAllDocs(projectId: string): Promise<number>;
}

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

  isDurableStorageConfigured?(): boolean;
}

export interface DocstoreMetricsSummary {
  totalReads: number;
  totalWrites: number;
  totalBytesWritten: number;
  occConflicts: number;
  noopSkips: number;
  activeDocs: number;
  archivedDocs: number;
}

export class DocstoreMetrics {
  private static totalReads = 0;
  private static totalWrites = 0;
  private static totalBytesWritten = 0;
  private static occConflicts = 0;
  private static noopSkips = 0;
  private static activeDocs = 0;
  private static archivedDocs = 0;

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

  public static updateDocCounts(active: number, archived: number): void {
    this.activeDocs = active;
    this.archivedDocs = archived;
  }

  public static getSummary(): DocstoreMetricsSummary {
    return {
      totalReads: this.totalReads,
      totalWrites: this.totalWrites,
      totalBytesWritten: this.totalBytesWritten,
      occConflicts: this.occConflicts,
      noopSkips: this.noopSkips,
      activeDocs: this.activeDocs,
      archivedDocs: this.archivedDocs,
    };
  }

  public static toPrometheus(): string {
    return [
      '# HELP docstore_reads_total Total number of document reads',
      '# TYPE docstore_reads_total counter',
      `docstore_reads_total ${this.totalReads}`,
      '',
      '# HELP docstore_writes_total Total number of document writes',
      '# TYPE docstore_writes_total counter',
      `docstore_writes_total ${this.totalWrites}`,
      '',
      '# HELP docstore_bytes_written_total Total byte volume written to docstore',
      '# TYPE docstore_bytes_written_total counter',
      `docstore_bytes_written_total ${this.totalBytesWritten}`,
      '',
      '# HELP docstore_occ_conflicts_total Total number of Optimistic Concurrency Control conflicts (409)',
      '# TYPE docstore_occ_conflicts_total counter',
      `docstore_occ_conflicts_total ${this.occConflicts}`,
      '',
      '# HELP docstore_noop_skips_total Total number of redundant updates skipped without writing to DB',
      '# TYPE docstore_noop_skips_total counter',
      `docstore_noop_skips_total ${this.noopSkips}`,
      '',
      '# HELP docstore_active_docs Current count of active documents in hot tier',
      '# TYPE docstore_active_docs gauge',
      `docstore_active_docs ${this.activeDocs}`,
      '',
      '# HELP docstore_archived_docs Current count of documents archived in cold tier',
      '# TYPE docstore_archived_docs gauge',
      `docstore_archived_docs ${this.archivedDocs}`,
    ].join('\n');
  }

  public static reset(): void {
    this.totalReads = 0;
    this.totalWrites = 0;
    this.totalBytesWritten = 0;
    this.occConflicts = 0;
    this.noopSkips = 0;
    this.activeDocs = 0;
    this.archivedDocs = 0;
  }
}
