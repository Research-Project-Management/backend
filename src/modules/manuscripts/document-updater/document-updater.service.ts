/**
 * document-updater/document-updater.service.ts
 * Module Façade Orchestrator for Manuscripts Document Updater.
 * Exposes internal APIs for CLSI compile coordination and WebSocket realtime integration.
 */

import { Injectable, OnModuleInit } from '@nestjs/common';
import { QueueDocUpdateUseCase, QueueDocUpdateOutput } from './core/use-cases/queue-doc-update.use-case';
import { FlushProjectDocsUseCase, FlushProjectDocsOutput } from './core/use-cases/flush-project-docs.use-case';
import { FlushSingleDocUseCase, FlushSingleDocOutput } from './core/use-cases/flush-single-doc.use-case';
import { GetInFlightDocUseCase } from './core/use-cases/get-in-flight-doc.use-case';
import { EvictDocBufferUseCase } from './core/use-cases/evict-doc-buffer.use-case';
import { IInFlightStorePort } from './core/ports/in-flight-store.port';
import { QueueUpdateDto } from './dto/queue-update.dto';
import { InFlightDocStateDto } from './dto/in-flight-doc-state.dto';

@Injectable()
export class DocumentUpdaterService implements OnModuleInit {
  constructor(
    private readonly queueUpdateUseCase: QueueDocUpdateUseCase,
    private readonly flushProjectUseCase: FlushProjectDocsUseCase,
    private readonly flushSingleDocUseCase: FlushSingleDocUseCase,
    private readonly getInFlightDocUseCase: GetInFlightDocUseCase,
    private readonly evictDocBufferUseCase: EvictDocBufferUseCase,
    private readonly inFlightStore: IInFlightStorePort,
  ) {}

  public onModuleInit(): void {
    // Wire cyclic reference between queue and single doc flush for debouncing
    this.queueUpdateUseCase.setFlushSingleDocUseCase(this.flushSingleDocUseCase);
  }

  /**
   * Queue real-time keystroke edits into fast memory/Redis write-behind buffer.
   */
  public async queueUpdate(
    projectId: string,
    docId: string,
    dto: QueueUpdateDto,
  ): Promise<QueueDocUpdateOutput> {
    return await this.queueUpdateUseCase.execute({
      projectId,
      docId,
      lines: dto.lines,
      splice: dto.splice,
      userId: dto.userId,
      clientRev: dto.clientRev,
      debounceMs: dto.debounceMs,
    });
  }

  /**
   * Primary "Flush-Before-Compile" integration hook.
   * Flushes all uncommitted changes for a project into docstore before CLSI compiles.
   */
  public async flushProject(projectId: string, force = false): Promise<FlushProjectDocsOutput> {
    return await this.flushProjectUseCase.execute({ projectId, force });
  }

  /**
   * Flushes a single document buffer into docstore.
   */
  public async flushDoc(
    projectId: string,
    docId: string,
    force = false,
  ): Promise<FlushSingleDocOutput> {
    return await this.flushSingleDocUseCase.execute({ projectId, docId, force });
  }

  /**
   * Gets current in-flight state of a document (buffered vs persistent baseline).
   */
  public async getDocState(projectId: string, docId: string): Promise<InFlightDocStateDto> {
    const result = await this.getInFlightDocUseCase.execute({ projectId, docId });
    return InFlightDocStateDto.fromEntity(result.doc, result.isBuffered);
  }

  /**
   * Flushes and releases memory/Redis buffer when users disconnect.
   */
  public async evictDoc(projectId: string, docId: string): Promise<void> {
    await this.evictDocBufferUseCase.execute({ projectId, docId });
  }

  /**
   * Query all dirty document IDs for a given project.
   */
  public async getDirtyDocIds(projectId: string): Promise<string[]> {
    return await this.inFlightStore.getDirtyDocIds(projectId);
  }
}
