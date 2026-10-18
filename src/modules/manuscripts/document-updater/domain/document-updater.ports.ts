/**
 * document-updater/domain/document-updater.ports.ts
 * Outbound Ports (SPI) and operation contracts for Document Updater.
 */

import { InFlightDoc } from './in-flight-doc.entity';

export interface BaseDocData {
  docId: string;
  projectId: string;
  lines: string[];
  rev: number;
  version?: number;
}

export interface CommitResult {
  docId: string;
  newRev: number;
  version: number;
  hash: string;
}

export interface QueueDocUpdateOutput {
  docId: string;
  projectId: string;
  rev: number;
  inFlightSeq: number;
  pendingOpsCount: number;
  isDirty: boolean;
}

export interface FlushProjectDocsOutput {
  projectId: string;
  flushedDocsCount: number;
  flushedDocIds: string[];
  skippedDocIds: string[];
  errors: Array<{ docId: string; error: string }>;
  durationMs: number;
}

export interface FlushSingleDocOutput {
  docId: string;
  projectId: string;
  flushed: boolean;
  newRev?: number;
  reason?: string;
}

export abstract class IInFlightStorePort {
  abstract get(projectId: string, docId: string): Promise<InFlightDoc | null>;
  abstract save(doc: InFlightDoc): Promise<void>;
  abstract delete(projectId: string, docId: string): Promise<void>;
  abstract getDirtyDocIds(projectId: string): Promise<string[]>;
  abstract getAllProjectIds(): Promise<string[]>;
  abstract clear(): Promise<void>;
}

export abstract class IDocstoreWriterPort {
  abstract fetchBaseDoc(
    projectId: string,
    docId: string,
  ): Promise<BaseDocData | null>;

  abstract commitDocUpdate(
    projectId: string,
    docId: string,
    lines: string[],
    rev: number,
  ): Promise<CommitResult>;
}

export abstract class IUpdaterLockPort {
  abstract acquire(resourceKey: string, ttlMs?: number): Promise<boolean>;
  abstract release(resourceKey: string): Promise<void>;
  abstract isLocked(resourceKey: string): Promise<boolean>;
}

export abstract class IDebounceTimerPort {
  abstract schedule(
    projectId: string,
    docId: string,
    delayMs: number,
    callback: () => Promise<void>,
  ): void;
  abstract cancel(projectId: string, docId: string): void;
  abstract cancelAllForProject(projectId: string): void;
  abstract cancelAll(): void;
}
