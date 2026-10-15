/**
 * project-history/core/use-cases/get-version-list.use-case.ts
 * Inbound Use Case listing all immutable snapshots and labels for a project.
 */

import { Injectable } from '@nestjs/common';
import { IHistoryRepositoryPort } from '@/modules/manuscripts/project-history/core/ports/history-repository.port';
import { Snapshot } from '@/modules/manuscripts/project-history/core/domain/entities/snapshot.entity';

@Injectable()
export class GetVersionListUseCase {
  constructor(private readonly historyRepository: IHistoryRepositoryPort) {}

  public async execute(projectId: string): Promise<Snapshot[]> {
    return await this.historyRepository.listVersions(projectId);
  }
}
