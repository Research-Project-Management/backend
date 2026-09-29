/**
 * linked-files/core/use-cases/list-linked-files.use-case.ts
 * Inbound Use Case: Retrieves all linked files for a given manuscript project.
 */

import { Injectable } from '@nestjs/common';
import { ILinkedFilesRepositoryPort } from '../ports/linked-files-repository.port';
import { LinkedFileEntity } from '../domain/entities/linked-file.entity';

@Injectable()
export class ListLinkedFilesUseCase {
  constructor(private readonly repository: ILinkedFilesRepositoryPort) {}

  public async execute(projectId: string): Promise<LinkedFileEntity[]> {
    return await this.repository.findByProject(projectId);
  }
}
