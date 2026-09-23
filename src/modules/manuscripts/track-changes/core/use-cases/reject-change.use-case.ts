/**
 * track-changes/core/use-cases/reject-change.use-case.ts
 * Inbound Use Case rejecting a proposed change and reverting text lines in Docstore.
 */

import { Injectable } from '@nestjs/common';
import { ITrackChangesRepositoryPort } from '../ports/track-changes-repository.port';
import { IDocstorePatcherPort } from '../ports/docstore-patcher.port';
import { IRealtimeNotifierPort } from '../ports/realtime-notifier.port';
import { TrackChange } from '../domain/entities/track-change.entity';
import { ChangeNotFoundException } from '../domain/exceptions/change-not-found.exception';

export interface RejectChangeInput {
  projectId: string;
  docId: string;
  changeId: string;
  userId?: string | null;
}

@Injectable()
export class RejectChangeUseCase {
  constructor(
    private readonly repository: ITrackChangesRepositoryPort,
    private readonly docstorePatcher: IDocstorePatcherPort,
    private readonly notifier: IRealtimeNotifierPort,
  ) {}

  public async execute(input: RejectChangeInput): Promise<TrackChange> {
    const { projectId, docId, changeId, userId } = input;

    const change = await this.repository.findChangeById(changeId);
    if (!change || change.projectId !== projectId || change.docId !== docId) {
      throw new ChangeNotFoundException(changeId);
    }

    // 1. Mark rejected on domain entity
    change.reject(userId);

    // 2. Revert change in Docstore
    await this.docstorePatcher.revertChange(projectId, docId, change);

    // 3. Persist resolved status
    const saved = await this.repository.saveChange(change);

    // 4. Notify peers
    this.notifier.notifyChangeResolved(projectId, docId, saved);

    return saved;
  }
}
