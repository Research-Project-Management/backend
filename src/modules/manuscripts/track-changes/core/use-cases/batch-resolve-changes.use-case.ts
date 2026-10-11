/**
 * track-changes/core/use-cases/batch-resolve-changes.use-case.ts
 * Inbound Use Case performing bulk 'accept_all' or 'reject_all' across a document.
 */

import { Injectable } from '@nestjs/common';
import { ITrackChangesRepositoryPort } from '../ports/track-changes-repository.port';
import { AcceptChangeUseCase } from './accept-change.use-case';
import { RejectChangeUseCase } from './reject-change.use-case';

export type BatchAction =
  | 'accept_all'
  | 'reject_all'
  | 'accept_selected'
  | 'reject_selected';

export interface BatchResolveInput {
  projectId: string;
  docId: string;
  action: BatchAction;
  changeIds?: string[];
  userId?: string | null;
}

export interface BatchResolveOutput {
  resolvedCount: number;
  action: BatchAction;
}

@Injectable()
export class BatchResolveChangesUseCase {
  constructor(
    private readonly repository: ITrackChangesRepositoryPort,
    private readonly acceptChangeUseCase: AcceptChangeUseCase,
    private readonly rejectChangeUseCase: RejectChangeUseCase,
  ) {}

  public async execute(input: BatchResolveInput): Promise<BatchResolveOutput> {
    const { projectId, docId, action, changeIds, userId } = input;

    // Fetch all pending changes for this doc
    const pendingChanges = await this.repository.listChangesByDoc(
      projectId,
      docId,
      'pending',
    );

    const targetChanges =
      changeIds && changeIds.length > 0
        ? pendingChanges.filter((c) => changeIds.includes(c.id))
        : pendingChanges;

    if (action === 'accept_all' || action === 'accept_selected') {
      for (const change of targetChanges) {
        await this.acceptChangeUseCase.execute({
          projectId,
          docId,
          changeId: change.id,
          userId,
        });
      }
    } else {
      // Reject in reverse order to preserve line indices
      const reversed = [...targetChanges].reverse();
      for (const change of reversed) {
        await this.rejectChangeUseCase.execute({
          projectId,
          docId,
          changeId: change.id,
          userId,
        });
      }
    }

    return {
      resolvedCount: targetChanges.length,
      action,
    };
  }
}
