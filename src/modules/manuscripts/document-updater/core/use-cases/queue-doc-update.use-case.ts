/**
 * document-updater/core/use-cases/queue-doc-update.use-case.ts
 * Application Use Case for queuing real-time edits into the in-flight write-behind buffer.
 */

import { Injectable, Logger } from '@nestjs/common';
import { IInFlightStorePort } from '../ports/in-flight-store.port';
import { IDocstoreWriterPort } from '../ports/docstore-writer.port';
import { IUpdaterLockPort } from '../ports/updater-lock.port';
import { IDebounceTimerPort } from '../ports/debounce-timer.port';
import { InFlightDoc } from '../domain/entities/in-flight-doc.entity';
import { UpdateOpVo } from '../domain/value-objects/update-op.vo';
import { DocumentVersionVo } from '../domain/value-objects/document-version.vo';
import { DocumentLockedException } from '../domain/exceptions/document-locked.exception';
import { InFlightNotFoundException } from '../domain/exceptions/in-flight-not-found.exception';
import { FlushSingleDocUseCase } from './flush-single-doc.use-case';

export interface QueueDocUpdateInput {
  projectId: string;
  docId: string;
  lines?: string[];
  splice?: {
    startLine: number;
    deleteCount: number;
    newLines: string[];
  };
  userId?: string;
  clientRev?: number;
  debounceMs?: number;
}

export interface QueueDocUpdateOutput {
  docId: string;
  projectId: string;
  rev: number;
  inFlightSeq: number;
  pendingOpsCount: number;
  isDirty: boolean;
}

@Injectable()
export class QueueDocUpdateUseCase {
  private readonly logger = new Logger(QueueDocUpdateUseCase.name);
  private flushSingleDocUseCase?: FlushSingleDocUseCase;

  constructor(
    private readonly inFlightStore: IInFlightStorePort,
    private readonly docstoreWriter: IDocstoreWriterPort,
    private readonly lock: IUpdaterLockPort,
    private readonly debounceTimer: IDebounceTimerPort,
  ) {}

  public setFlushSingleDocUseCase(useCase: FlushSingleDocUseCase): void {
    this.flushSingleDocUseCase = useCase;
  }

  public async execute(input: QueueDocUpdateInput): Promise<QueueDocUpdateOutput> {
    const { projectId, docId, debounceMs = 1500 } = input;

    // 1. Concurrency guard: check if project or doc is locked
    const isProjectLocked = await this.lock.isLocked(`project:${projectId}`);
    if (isProjectLocked) {
      throw new DocumentLockedException(projectId, 'Project is locked for compilation or batch flush.');
    }

    // 2. Fetch or load in-flight document
    let inFlightDoc = await this.inFlightStore.get(projectId, docId);

    if (!inFlightDoc) {
      // Hydrate baseline from Docstore
      const baseDoc = await this.docstoreWriter.fetchBaseDoc(projectId, docId);
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

    // 3. Create and apply update operation
    let op: UpdateOpVo;
    if (input.lines) {
      op = UpdateOpVo.fromLines(input.lines, input.userId, input.clientRev);
    } else if (input.splice) {
      op = UpdateOpVo.fromSplice(
        input.splice.startLine,
        input.splice.deleteCount,
        input.splice.newLines,
        input.userId,
        input.clientRev,
      );
    } else {
      throw new Error('Update must provide either full lines array or splice parameters.');
    }

    inFlightDoc.applyUpdate(op);

    // 4. Save to in-flight store (Redis/Memory)
    await this.inFlightStore.save(inFlightDoc);

    // 5. Schedule idle debounce flush
    if (this.flushSingleDocUseCase) {
      this.debounceTimer.schedule(projectId, docId, debounceMs, async () => {
        if (this.flushSingleDocUseCase) {
          await this.flushSingleDocUseCase.execute({ projectId, docId });
        }
      });
    }

    return {
      docId: inFlightDoc.docId,
      projectId: inFlightDoc.projectId,
      rev: inFlightDoc.rev,
      inFlightSeq: inFlightDoc.inFlightSeq,
      pendingOpsCount: inFlightDoc.pendingOpsCount,
      isDirty: inFlightDoc.isDirty,
    };
  }
}
