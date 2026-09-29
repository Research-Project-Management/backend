/**
 * linked-files/core/use-cases/delete-linked-file.use-case.ts
 * Inbound Use Case: Unlinks a linked file record and optionally removes the node from the file tree.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { ILinkedFilesRepositoryPort } from '../ports/linked-files-repository.port';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';

@Injectable()
export class DeleteLinkedFileUseCase {
  constructor(
    private readonly repository: ILinkedFilesRepositoryPort,
    private readonly structureService: StructureService,
  ) {}

  public async execute(
    projectId: string,
    id: string,
    deleteNode = false,
  ): Promise<void> {
    const linkedFile = await this.repository.findById(projectId, id);
    if (!linkedFile) {
      throw new NotFoundException(`Linked file "${id}" not found`);
    }

    if (deleteNode && linkedFile.nodeId) {
      await this.structureService
        .deleteNode(projectId, linkedFile.nodeId)
        .catch(() => {});
    }

    await this.repository.delete(projectId, id);
  }
}
