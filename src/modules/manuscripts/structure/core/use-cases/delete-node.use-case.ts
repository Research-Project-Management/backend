/**
 * modules/manuscripts/structure/core/use-cases/delete-node.use-case.ts
 * Deletes a file, document, or folder (along with all nested descendants).
 */

import { Injectable } from '@nestjs/common';
import { IStructureRepository } from '../ports/structure-repository.port';
import { ITreePublisher } from '../ports/tree-publisher.port';
import { ManuscriptNodeEntity } from '../domain/manuscript-node.entity';
import { NodeNotFoundError, CannotDeleteRootFolderError } from '../domain/structure-errors';

@Injectable()
export class DeleteNodeUseCase {
  constructor(
    private readonly structureRepository: IStructureRepository,
    private readonly treePublisher: ITreePublisher
  ) {}

  public async execute(projectId: string, nodeId: string): Promise<ManuscriptNodeEntity[]> {
    const node = await this.structureRepository.findById(projectId, nodeId);
    if (!node) {
      throw new NodeNotFoundError(nodeId);
    }
    if (node.path === '/') {
      throw new CannotDeleteRootFolderError();
    }

    const deletedNodes = await this.structureRepository.deleteSubtree(projectId, node.path);

    // Check if any deleted node was marked as root doc
    const hadRootDoc = deletedNodes.some((n) => n.isRootDoc);
    if (hadRootDoc) {
      await this.structureRepository.unsetRootDoc(projectId);
    }

    await this.treePublisher.publishTreeMutation({
      projectId,
      action: 'delete',
      nodeId: node.id,
      path: node.path,
      entityType: node.type,
      data: { deletedCount: deletedNodes.length, hadRootDoc },
    });

    return deletedNodes;
  }
}
