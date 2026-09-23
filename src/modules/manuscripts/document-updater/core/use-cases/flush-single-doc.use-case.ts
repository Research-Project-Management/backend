/**
 * document-updater/core/use-cases/flush-single-doc.use-case.ts
 * Application Use Case for committing a single dirty in-flight document buffer into Docstore.
 */

import { Injectable, Logger } from '@nestjs/common';
import { IInFlightStorePort } from '../ports/in-flight-store.port';
import { IDocstoreWriterPort } from '../ports/docstore-writer.port';
import { IUpdaterLockPort } from '../ports/updater-lock.port';
import { IDebounceTimerPort } from '../ports/debounce-timer.port';
import { DocumentLockedException } from '../domain/exceptions/document-locked.exception';
import { DocUpdaterConflictException } from '../domain/exceptions/doc-updater-conflict.exception';

export interface FlushSingleDocInput {
  projectId: string;
  docId: string;
  force?: boolean;
}

export interface FlushSingleDocOutput {
  docId: string;
  projectId: string;
  flushed: boolean;
  newRev?: number;
  reason?: string;
}

@Injectable()
export class FlushSingleDocUseCase {
  private readonly logger = new Logger(FlushSingleDocUseCase.name);

  constructor(
    private readonly inFlightStore: IInFlightStorePort,
    private readonly docstoreWriter: IDocstoreWriterPort,
    private readonly lock: IUpdaterLockPort,
    private readonly debounceTimer: IDebounceTimerPort,
  ) {}

  public async execute(input: FlushSingleDocInput): Promise<FlushSingleDocOutput> {
    const { projectId, docId } = input;
    const lockKey = `doc:${docId}`;

    // 1. Acquire doc-level exclusive lock
    const acquired = await this.lock.acquire(lockKey, 10000);
    if (!acquired) {
      throw new DocumentLockedException(docId, 'Document is currently being flushed by another worker.');
    }

    try {
      // 2. Fetch in-flight document buffer
      const doc = await this.inFlightStore.get(projectId, docId);
      if (!doc) {
        return { docId, projectId, flushed: false, reason: 'Document is not active in memory buffer.' };
      }

      if (!doc.isDirty && !input.force) {
        return { docId, projectId, flushed: false, reason: 'Document is already clean (0 uncommitted changes).' };
      }

      // 3. Mark as flushing
      doc.markFlushing();
      await this.inFlightStore.save(doc);

      // 4. Commit to Docstore
      try {
        const commitResult = await this.docstoreWriter.commitDocUpdate(
          projectId,
          docId,
          doc.lines,
          doc.rev,
        );

        // 5. Update in-flight state to clean
        doc.markFlushed(commitResult.newRev);
        await this.inFlightStore.save(doc);

        // 6. Cancel pending debounce timer
        this.debounceTimer.cancel(projectId, docId);

        this.logger.log(
          `[DocUpdater] Successfully flushed doc '${docId}' in project '${projectId}' to rev ${commitResult.newRev}.`,
        );

        return {
          docId,
          projectId,
          flushed: true,
          newRev: commitResult.newRev,
        };
      } catch (err) {
        doc.markFlushFailed();
        await this.inFlightStore.save(doc);

        if (err instanceof DocUpdaterConflictException) {
          this.logger.warn(
            `[DocUpdater] OCC Conflict flushing doc '${docId}': ${err.message}. Retaining dirty state for reconciliation.`,
          );
        }
        throw err;
      }
    } finally {
      await this.lock.release(lockKey);
    }
  }
}
