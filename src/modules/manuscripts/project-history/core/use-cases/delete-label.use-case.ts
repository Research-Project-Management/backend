/**
 * project-history/core/use-cases/delete-label.use-case.ts
 * Inbound Use Case removing a named label from project history.
 */

import { Injectable } from '@nestjs/common';
import { IHistoryRepositoryPort } from '../ports/history-repository.port';

@Injectable()
export class DeleteLabelUseCase {
  constructor(private readonly historyRepository: IHistoryRepositoryPort) {}

  public async execute(projectId: string, labelId: string): Promise<void> {
    await this.historyRepository.deleteLabel(projectId, labelId);
  }
}
