/**
 * document-updater/document-updater.service.ts
 * Deep Module Service for Manuscripts Document Updater.
 * Consolidates write-behind buffering, debounced single-doc flush,
 * Flush-Before-Compile project batch flush, in-flight state queries, and eviction.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { mapSettledWithConcurrency } from '@/core';
import { DocumentUpdaterRepository } from './document-updater.repository';
import { InFlightDoc } from './core/domain/entities/in-flight-doc.entity';
import { UpdateOpVo } from './core/domain/value-objects/update-op.vo';
import { DocumentVersionVo } from './core/domain/value-objects/document-version.vo';
import { DocumentLockedException } from './core/domain/exceptions/document-locked.exception';
import { DocUpdaterConflictException } from './core/domain/exceptions/doc-updater-conflict.exception';
import { InFlightNotFoundException } from './core/domain/exceptions/in-flight-not-found.exception';
import { QueueDocUpdateOutput } from './core/use-cases/queue-doc-update.use-case';
import { FlushProjectDocsOutput } from './core/use-cases/flush-project-docs.use-case';
import { FlushSingleDocOutput } from './core/use-cases/flush-single-doc.use-case';
import { QueueUpdateDto } from './dto/queue-update.dto';
import { InFlightDocStateDto } from './dto/in-flight-doc-state.dto';

@Injectable()
export class DocumentUpdaterService implements OnModuleInit {
  private readonly logger = new Logger(DocumentUpdaterService.name);

  constructor(private readonly repository: DocumentUpdaterRepository) {}

  public onModuleInit(): void {
    // Lifecycle initialization
  }

  /**
   * Queue real-time keystroke edits into fast memory/Redis write-behind buffer.
   */
  public async queueUpdate(
    projectId: string,
    docId: string,
    dto: QueueUpdateDto,
  ): Promise<QueueDocUpdateOutput> {
    const repo = this.repository;
    const debounceMs = dto.debounceMs ?? 1500;

    const isProjectLocked = await repo.isLocked(`project:${projectId}`);
    if (isProjectLocked) {
      throw new DocumentLockedException(
        projectId,
        'Project is locked for compilation or batch flush.',
      );
    }

    let inFlightDoc = await repo.get(projectId, docId);
    if (!inFlightDoc) {
      const baseDoc = await repo.fetchBaseDoc(projectId, docId);
      if (!baseDoc) {
        throw new InFlightNotFoundException(docId, projectId);
      }

      inFlightDoc = InFlightDoc.create({
        docId,
        projectId,
        lines: baseDoc.lines,
        version: DocumentVersionVo.initial(baseDoc.rev),
      });
    }

    let op: UpdateOpVo;
    if (dto.lines) {
      op = UpdateOpVo.fromLines(dto.lines, dto.userId, dto.clientRev);
    } else if (dto.splice) {
      op = UpdateOpVo.fromSplice(
        dto.splice.startLine,
        dto.splice.deleteCount,
        dto.splice.newLines,
        dto.userId,
        dto.clientRev,
      );
    } else {
      throw new Error(
        'Update must provide either full lines array or splice parameters.',
      );
    }

    inFlightDoc.applyUpdate(op);
    await repo.save(inFlightDoc);

    repo.scheduleDebounce(projectId, docId, debounceMs, async () => {
      await this.flushDoc(projectId, docId);
    });

    return {
      docId: inFlightDoc.docId,
      projectId: inFlightDoc.projectId,
      rev: inFlightDoc.rev,
      inFlightSeq: inFlightDoc.inFlightSeq,
      pendingOpsCount: inFlightDoc.pendingOpsCount,
      isDirty: inFlightDoc.isDirty,
    };
  }

  /**
   * Primary "Flush-Before-Compile" integration hook.
   * Flushes all uncommitted changes for a project into docstore before CLSI compiles.
   */
  public async flushProject(
    projectId: string,
    force = false,
  ): Promise<FlushProjectDocsOutput> {
    const startTime = Date.now();
    const lockKey = `project:${projectId}`;

    const maxWaitMs = 1500;
    const intervalMs = 100;
    const lockWaitStart = Date.now();
    let acquired = await this.repository.acquireLock(lockKey, 30000);
    while (!acquired && Date.now() - lockWaitStart < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      acquired = await this.repository.acquireLock(lockKey, 30000);
    }

    if (!acquired) {
      throw new DocumentLockedException(
        projectId,
        'Project is currently undergoing another flush or compilation cycle.',
      );
    }

    this.repository.cancelAllProjectDebounces(projectId);

    const flushedDocIds: string[] = [];
    const skippedDocIds: string[] = [];
    const errors: Array<{ docId: string; error: string }> = [];

    try {
      const dirtyDocIds = await this.repository.getDirtyDocIds(projectId);

      this.logger.log(
        `[DocUpdater] Flushing project '${projectId}': Found ${dirtyDocIds.length} dirty document(s).`,
      );

      const flushResults = await mapSettledWithConcurrency(
        dirtyDocIds,
        5,
        async (docId) => {
          return await this.flushDoc(projectId, docId, force);
        },
      );

      for (let i = 0; i < dirtyDocIds.length; i++) {
        const docId = dirtyDocIds[i];
        const res = flushResults[i];
        if (res.ok) {
          if (res.value.flushed) {
            flushedDocIds.push(docId);
          } else {
            skippedDocIds.push(docId);
          }
        } else {
          const errMsg = (res.error as Error)?.message || String(res.error);
          errors.push({ docId, error: errMsg });
          this.logger.error(
            `[DocUpdater] Error flushing doc '${docId}' in project '${projectId}': ${errMsg}`,
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
      await this.repository.releaseLock(lockKey);
    }
  }

  /**
   * Flushes a single document buffer into docstore.
   */
  public async flushDoc(
    projectId: string,
    docId: string,
    force = false,
  ): Promise<FlushSingleDocOutput> {
    const lockKey = `doc:${docId}`;

    const acquired = await this.repository.acquireLock(lockKey, 10000);
    if (!acquired) {
      throw new DocumentLockedException(
        docId,
        'Document is currently being flushed by another worker.',
      );
    }

    try {
      const doc = await this.repository.get(projectId, docId);
      if (!doc) {
        return {
          docId,
          projectId,
          flushed: false,
          reason: 'Document is not active in memory buffer.',
        };
      }

      if (!doc.isDirty && !force) {
        return {
          docId,
          projectId,
          flushed: false,
          reason: 'Document is already clean (0 uncommitted changes).',
        };
      }

      doc.markFlushing();
      await this.repository.save(doc);

      try {
        const commitResult = await this.repository.commitDocUpdate(
          projectId,
          docId,
          doc.lines,
          doc.rev,
        );

        doc.markFlushed(commitResult.newRev);
        await this.repository.save(doc);
        this.repository.cancelDebounce(projectId, docId);

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
        await this.repository.save(doc);

        if (err instanceof DocUpdaterConflictException) {
          this.logger.warn(
            `[DocUpdater] OCC Conflict flushing doc '${docId}': ${err.message}. Retaining dirty state for reconciliation.`,
          );
        }
        throw err;
      }
    } finally {
      await this.repository.releaseLock(lockKey);
    }
  }

  /**
   * Gets current in-flight state of a document (buffered vs persistent baseline).
   */
  public async getDocState(
    projectId: string,
    docId: string,
  ): Promise<InFlightDocStateDto> {
    const activeDoc = await this.repository.get(projectId, docId);
    if (activeDoc) {
      return InFlightDocStateDto.fromEntity(activeDoc, true);
    }

    const baseDoc = await this.repository.fetchBaseDoc(projectId, docId);
    if (!baseDoc) {
      throw new InFlightNotFoundException(docId, projectId);
    }

    const doc = InFlightDoc.create({
      docId,
      projectId,
      lines: baseDoc.lines,
      version: DocumentVersionVo.initial(baseDoc.rev),
    });

    return InFlightDocStateDto.fromEntity(doc, false);
  }

  /**
   * Flushes and releases memory/Redis buffer when users disconnect.
   */
  public async evictDoc(projectId: string, docId: string): Promise<void> {
    this.repository.cancelDebounce(projectId, docId);

    const doc = await this.repository.get(projectId, docId);
    if (doc && doc.isDirty) {
      await this.flushDoc(projectId, docId, true);
    }

    await this.repository.delete(projectId, docId);
    this.logger.log(
      `[DocUpdater] Evicted document buffer for '${docId}' in project '${projectId}'.`,
    );
  }

  /**
   * Query all dirty document IDs for a given project.
   */
  public async getDirtyDocIds(projectId: string): Promise<string[]> {
    return await this.repository.getDirtyDocIds(projectId);
  }
}
