/**
 * track-changes/core/use-cases/batch-resolve-changes.use-case.ts
 * Inbound Use Case performing bulk 'accept_all' or 'reject_all' across a document.
 */

import { Injectable } from '@nestjs/common';
import { ITrackChangesRepositoryPort } from '@/modules/manuscripts/track-changes/core/ports/track-changes-repository.port';
import { AcceptChangeUseCase } from './accept-change.use-case';
import { RejectChangeUseCase } from './reject-change.use-case';

export type BatchAction =
  'accept_all' | 'reject_all' | 'accept_selected' | 'reject_selected';

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

    const filteredChanges =
      changeIds && changeIds.length > 0
        ? pendingChanges.filter((c) => changeIds.includes(c.id))
        : pendingChanges;

    // Sort in descending document position order (bottom-to-top, right-to-left)
    // so that line/column mutations from accepting deletes or rejecting inserts/deletes
    // never shift the coordinates of changes earlier in the document.
    const targetChanges = [...filteredChanges].sort((a, b) => {
      if (b.range.startLine !== a.range.startLine) {
        return b.range.startLine - a.range.startLine;
      }
      return b.range.startCol - a.range.startCol;
    });

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
      for (const change of targetChanges) {
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
