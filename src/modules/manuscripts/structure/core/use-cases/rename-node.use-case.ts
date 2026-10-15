/**
 * modules/manuscripts/structure/core/use-cases/rename-node.use-case.ts
 * Renames a node and cascades path updates to all child descendants if it is a folder.
 */

import { Injectable } from '@nestjs/common';
import { IStructureRepository } from '@/modules/manuscripts/structure/core/ports/structure-repository.port';
import { ITreePublisher } from '@/modules/manuscripts/structure/core/ports/tree-publisher.port';
import { NodePathVo } from '@/modules/manuscripts/structure/core/domain/node-path.vo';
import { ManuscriptNodeEntity } from '@/modules/manuscripts/structure/core/domain/manuscript-node.entity';
import {
  NodeNotFoundError,
  DuplicateNodePathError,
  CannotDeleteRootFolderError,
} from '@/modules/manuscripts/structure/core/domain/structure-errors';

@Injectable()
export class RenameNodeUseCase {
  constructor(
    private readonly structureRepository: IStructureRepository,
    private readonly treePublisher: ITreePublisher,
  ) {}

  public async execute(
    projectId: string,
    nodeId: string,
    newName: string,
  ): Promise<ManuscriptNodeEntity> {
    NodePathVo.validateFilename(newName);

    const node = await this.structureRepository.findById(projectId, nodeId);
    if (!node) {
      throw new NodeNotFoundError(nodeId);
    }
    if (node.path === '/') {
      throw new CannotDeleteRootFolderError();
    }

    if (node.name === newName) {
      return node; // No-op rename
    }

    const parentPath = NodePathVo.dirname(node.path);
    const newPath = NodePathVo.join(parentPath, newName);

    // Check conflict
    const existing = await this.structureRepository.findByPath(
      projectId,
      newPath,
    );
    if (existing && existing.id !== node.id) {
      throw new DuplicateNodePathError(newPath);
    }

    const oldPath = node.path;
    let updated: ManuscriptNodeEntity;

    if (node.isFolder()) {
      // Moving folder to newPath with same parentId cascades descendants
      await this.structureRepository.moveSubtree(
        projectId,
        oldPath,
        newPath,
        node.parentId,
      );
      updated = (await this.structureRepository.findById(projectId, node.id))!;
    } else {
      updated = await this.structureRepository.renameNode(
        projectId,
        node.id,
        newName,
        newPath,
      );
    }

    await this.treePublisher.publishTreeMutation({
      projectId,
      action: 'rename',
      nodeId: updated.id,
      path: updated.path,
      oldPath,
      entityType: updated.type,
      data: { oldName: node.name, newName },
    });

    return updated;
  }
}
