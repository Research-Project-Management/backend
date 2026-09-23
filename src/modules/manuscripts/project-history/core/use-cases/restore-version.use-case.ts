/**
 * project-history/core/use-cases/restore-version.use-case.ts
 * Inbound Use Case restoring project files and structure to a historical version.
 * Adheres strictly to non-destructive history by committing a new snapshot (version N+1).
 */

import { Injectable } from '@nestjs/common';
import { IHistoryRepositoryPort } from '../ports/history-repository.port';
import { IProjectRestorerPort, RestoreResult } from '../ports/project-restorer.port';
import { CreateSnapshotUseCase } from './create-snapshot.use-case';
import { Snapshot } from '../domain/entities/snapshot.entity';
import { VersionNotFoundException } from '../domain/exceptions/version-not-found.exception';

export interface RestoreVersionInput {
  projectId: string;
  targetVersion: number;
  userId?: string | null;
}

export interface RestoreVersionOutput {
  targetSnapshot: Snapshot;
  newSnapshot: Snapshot;
  restoreResult: RestoreResult;
}

@Injectable()
export class RestoreVersionUseCase {
  constructor(
    private readonly historyRepository: IHistoryRepositoryPort,
    private readonly projectRestorer: IProjectRestorerPort,
    private readonly createSnapshotUseCase: CreateSnapshotUseCase,
  ) {}

  public async execute(input: RestoreVersionInput): Promise<RestoreVersionOutput> {
    const { projectId, targetVersion, userId } = input;

    // 1. Retrieve the historical snapshot
    const targetSnapshot = await this.historyRepository.findByVersion(projectId, targetVersion);
    if (!targetSnapshot) {
      throw new VersionNotFoundException(projectId, targetVersion);
    }

    // 2. Apply snapshot state into active structure & docstore
    const restoreResult = await this.projectRestorer.restoreToState(projectId, targetSnapshot);

    // 3. Commit non-destructive history: snapshot version N + 1
    const newSnapshot = await this.createSnapshotUseCase.execute({
      projectId,
      summary: `Restored to version ${targetVersion}`,
      createdById: userId || null,
      isAutomatic: false,
    });

    return {
      targetSnapshot,
      newSnapshot,
      restoreResult,
    };
  }
}
