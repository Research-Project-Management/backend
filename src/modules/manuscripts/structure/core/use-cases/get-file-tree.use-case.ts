/**
 * modules/manuscripts/structure/core/use-cases/get-file-tree.use-case.ts
 * Builds a hierarchical nested tree (TreeNodeDto) for client IDE sidebar.
 */

import { Injectable } from '@nestjs/common';
import { IStructureRepository } from '@/modules/manuscripts/structure/core/ports/structure-repository.port';
import { ManuscriptNodeEntity } from '@/modules/manuscripts/structure/core/domain/manuscript-node.entity';
import { TreeNodeDto } from '@/modules/manuscripts/structure/dto/node.dto';
import { FileTreeBuilder } from '@/modules/manuscripts/structure/domain/file-tree.builder';

@Injectable()
export class GetFileTreeUseCase {
  constructor(private readonly structureRepository: IStructureRepository) {}

  public async execute(projectId: string): Promise<TreeNodeDto[]> {
    const nodes = await this.structureRepository.getAllNodes(projectId);
    return this.buildTreeHierarchy(nodes);
  }

  /**
   * Transforms flat nodes into a sorted recursive tree.
   * Folders are sorted before files; within the same type, sorted by sortOrder then name.
   */
  public buildTreeHierarchy(nodes: ManuscriptNodeEntity[]): TreeNodeDto[] {
    return FileTreeBuilder.buildTreeHierarchy(nodes);
  }
}
