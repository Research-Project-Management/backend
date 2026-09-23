/**
 * document-updater/core/use-cases/evict-doc-buffer.use-case.ts
 * Application Use Case for cleanly flushing and evicting an idle document buffer from memory/Redis
 * when all active collaborative users disconnect.
 */

import { Injectable, Logger } from '@nestjs/common';
import { IInFlightStorePort } from '../ports/in-flight-store.port';
import { IDebounceTimerPort } from '../ports/debounce-timer.port';
import { FlushSingleDocUseCase } from './flush-single-doc.use-case';

export interface EvictDocBufferInput {
  projectId: string;
  docId: string;
}

@Injectable()
export class EvictDocBufferUseCase {
  private readonly logger = new Logger(EvictDocBufferUseCase.name);

  constructor(
    private readonly inFlightStore: IInFlightStorePort,
    private readonly debounceTimer: IDebounceTimerPort,
    private readonly flushSingleDocUseCase: FlushSingleDocUseCase,
  ) {}

  public async execute(input: EvictDocBufferInput): Promise<void> {
    const { projectId, docId } = input;

    // 1. Cancel pending debounce timers
    this.debounceTimer.cancel(projectId, docId);

    // 2. Check if dirty; if dirty, flush before evicting
    const doc = await this.inFlightStore.get(projectId, docId);
    if (doc && doc.isDirty) {
      await this.flushSingleDocUseCase.execute({ projectId, docId, force: true });
    }

    // 3. Remove from buffer
    await this.inFlightStore.delete(projectId, docId);
    this.logger.log(`[DocUpdater] Evicted document buffer for '${docId}' in project '${projectId}'.`);
  }
}
