/**
 * track-changes/core/use-cases/accept-change.use-case.ts
 * Inbound Use Case accepting a proposed change, permanently mutating Docstore text lines.
 */

import { Injectable } from '@nestjs/common';
import { ITrackChangesRepositoryPort } from '../ports/track-changes-repository.port';
import { IDocstorePatcherPort } from '../ports/docstore-patcher.port';
import { IRealtimeNotifierPort } from '../ports/realtime-notifier.port';
import { TrackChange } from '../domain/entities/track-change.entity';
import { ChangeNotFoundException } from '../domain/exceptions/change-not-found.exception';

export interface AcceptChangeInput {
  projectId: string;
  docId: string;
  changeId: string;
  userId?: string | null;
}

@Injectable()
export class AcceptChangeUseCase {
  constructor(
    private readonly repository: ITrackChangesRepositoryPort,
    private readonly docstorePatcher: IDocstorePatcherPort,
    private readonly notifier: IRealtimeNotifierPort,
  ) {}

  public async execute(input: AcceptChangeInput): Promise<TrackChange> {
    const { projectId, docId, changeId, userId } = input;

    const change = await this.repository.findChangeById(changeId);
    if (!change || change.projectId !== projectId || change.docId !== docId) {
      throw new ChangeNotFoundException(changeId);
    }

    // 1. Mark accepted on domain entity
    change.accept(userId);

    // 2. Apply change into persistent Docstore lines
    await this.docstorePatcher.applyChange(projectId, docId, change);

    // 3. Persist resolved status
    const saved = await this.repository.saveChange(change);

    // 4. Notify peers
    this.notifier.notifyChangeResolved(projectId, docId, saved);

    return saved;
  }
}
