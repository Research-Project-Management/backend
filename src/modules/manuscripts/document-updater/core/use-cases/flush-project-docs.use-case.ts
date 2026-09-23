/**
 * document-updater/core/use-cases/flush-project-docs.use-case.ts
 * Application Use Case orchestrating batch project flush ("Flush-Before-Compile").
 * Guaranteed synchronization of all uncommitted text edits before CLSI compiles a manuscript.
 */

import { Injectable, Logger } from '@nestjs/common';
import { IInFlightStorePort } from '../ports/in-flight-store.port';
import { IUpdaterLockPort } from '../ports/updater-lock.port';
import { IDebounceTimerPort } from '../ports/debounce-timer.port';
import { DocumentLockedException } from '../domain/exceptions/document-locked.exception';
import { FlushSingleDocUseCase } from './flush-single-doc.use-case';

export interface FlushProjectDocsInput {
  projectId: string;
  force?: boolean;
}

export interface FlushProjectDocsOutput {
  projectId: string;
  flushedDocsCount: number;
  flushedDocIds: string[];
  skippedDocIds: string[];
  errors: Array<{ docId: string; error: string }>;
  durationMs: number;
}

@Injectable()
export class FlushProjectDocsUseCase {
  private readonly logger = new Logger(FlushProjectDocsUseCase.name);

  constructor(
    private readonly inFlightStore: IInFlightStorePort,
    private readonly lock: IUpdaterLockPort,
    private readonly debounceTimer: IDebounceTimerPort,
    private readonly flushSingleDocUseCase: FlushSingleDocUseCase,
  ) {}

  public async execute(input: FlushProjectDocsInput): Promise<FlushProjectDocsOutput> {
    const { projectId } = input;
    const startTime = Date.now();
    const lockKey = `project:${projectId}`;

    // 1. Acquire project-level lock to prevent concurrent compile collisions
    const acquired = await this.lock.acquire(lockKey, 30000);
    if (!acquired) {
      throw new DocumentLockedException(
        projectId,
        'Project is currently undergoing another flush or compilation cycle.',
      );
    }

    // 2. Pause and cancel all pending debounce timers for this project
    this.debounceTimer.cancelAllForProject(projectId);

    const flushedDocIds: string[] = [];
    const skippedDocIds: string[] = [];
    const errors: Array<{ docId: string; error: string }> = [];

    try {
      // 3. Retrieve all dirty doc IDs
      const dirtyDocIds = await this.inFlightStore.getDirtyDocIds(projectId);

      this.logger.log(
        `[DocUpdater] Flushing project '${projectId}': Found ${dirtyDocIds.length} dirty document(s).`,
      );

      // 4. Sequentially flush each dirty doc into Docstore
      for (const docId of dirtyDocIds) {
        try {
          const res = await this.flushSingleDocUseCase.execute({
            projectId,
            docId,
            force: input.force,
          });

          if (res.flushed) {
            flushedDocIds.push(docId);
          } else {
            skippedDocIds.push(docId);
          }
        } catch (err) {
          errors.push({
            docId,
            error: (err as Error).message,
          });
          this.logger.error(
            `[DocUpdater] Error flushing doc '${docId}' in project '${projectId}': ${(err as Error).message}`,
          );
        }
      }

      const durationMs = Date.now() - startTime;
      this.logger.log(
        `[DocUpdater] Project '${projectId}' flushed in ${durationMs}ms. (${flushedDocIds.length} flushed, ${errors.length} errors).`,
      );

      return {
        projectId,
        flushedDocsCount: flushedDocIds.length,
        flushedDocIds,
        skippedDocIds,
        errors,
        durationMs,
      };
    } finally {
      await this.lock.release(lockKey);
    }
  }
}
