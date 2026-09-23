/**
 * project-history/core/use-cases/get-snapshot-by-version.use-case.ts
 * Inbound Use Case retrieving a specific version snapshot with file tree and content details.
 */

import { Injectable } from '@nestjs/common';
import { IHistoryRepositoryPort } from '../ports/history-repository.port';
import { Snapshot } from '../domain/entities/snapshot.entity';
import { VersionNotFoundException } from '../domain/exceptions/version-not-found.exception';

@Injectable()
export class GetSnapshotByVersionUseCase {
  constructor(private readonly historyRepository: IHistoryRepositoryPort) {}

  public async execute(projectId: string, version: number): Promise<Snapshot> {
    const snapshot = await this.historyRepository.findByVersion(projectId, version);
    if (!snapshot) {
      throw new VersionNotFoundException(projectId, version);
    }
    return snapshot;
  }
}
