/**
 * modules/manuscripts/structure/core/use-cases/move-node.use-case.ts
 * Moves a file, document, or folder (and all descendants) with cycle detection.
 */

import { Injectable } from '@nestjs/common';
import { IStructureRepository } from '@/modules/manuscripts/structure/core/ports/structure-repository.port';
import { ITreePublisher } from '@/modules/manuscripts/structure/core/ports/tree-publisher.port';
import { NodePathVo } from '@/modules/manuscripts/structure/core/domain/node-path.vo';
import { ManuscriptNodeEntity } from '@/modules/manuscripts/structure/core/domain/manuscript-node.entity';
import {
  NodeNotFoundError,
  CyclicMoveError,
  DuplicateNodePathError,
  CannotDeleteRootFolderError,
} from '@/modules/manuscripts/structure/core/domain/structure-errors';
import { MoveNodeDto } from '@/modules/manuscripts/structure/dto/node.dto';

@Injectable()
export class MoveNodeUseCase {
  constructor(
    private readonly structureRepository: IStructureRepository,
    private readonly treePublisher: ITreePublisher,
  ) {}

  public async execute(
    projectId: string,
    nodeId: string,
    dto: MoveNodeDto,
  ): Promise<ManuscriptNodeEntity> {
    const node = await this.structureRepository.findById(projectId, nodeId);
    if (!node) {
      throw new NodeNotFoundError(nodeId);
    }
    if (node.path === '/') {
      throw new CannotDeleteRootFolderError();
    }

    let destPath: string;
    let newParentId: string | null = null;
    const targetParentId =
      dto.destParentId !== undefined ? dto.destParentId : dto.parentId;

    if (targetParentId) {
      const destParent = await this.structureRepository.findById(
        projectId,
        targetParentId,
      );
      if (!destParent) {
        throw new NodeNotFoundError(targetParentId);
      }
      if (!destParent.isFolder()) {
        throw new Error('Destination parent must be a FOLDER');
      }
      destPath = NodePathVo.join(destParent.path, node.name);
      newParentId = destParent.id;
    } else if (dto.destPath) {
      destPath = NodePathVo.normalize(dto.destPath);
      NodePathVo.validateFilename(NodePathVo.basename(destPath));
      const parentPath = NodePathVo.dirname(destPath);
      if (parentPath !== '/') {
        const parentNode = await this.structureRepository.findByPath(
          projectId,
          parentPath,
        );
        if (parentNode && !parentNode.isFolder()) {
          throw new Error('Destination parent must be a FOLDER');
        }
        newParentId = parentNode ? parentNode.id : null;
      }
    } else {
      // Moved to root
      destPath = NodePathVo.join('/', node.name);
      newParentId = null;
    }

    // Cycle detection: destination cannot be within source's subtree
    if (
      node.isFolder() &&
      (destPath === node.path || NodePathVo.isDescendant(node.path, destPath))
    ) {
      throw new CyclicMoveError(node.path, destPath);
    }

    // Check if duplicate exists at target
    const existing = await this.structureRepository.findByPath(
      projectId,
      destPath,
    );
    if (existing && existing.id !== node.id) {
      throw new DuplicateNodePathError(destPath);
    }

    const oldPath = node.path;
    await this.structureRepository.moveSubtree(
      projectId,
      oldPath,
      destPath,
      newParentId,
    );

    const updated = (await this.structureRepository.findById(
      projectId,
      node.id,
    ))!;

    await this.treePublisher.publishTreeMutation({
      projectId,
      action: 'move',
      nodeId: updated.id,
      path: updated.path,
      oldPath,
      entityType: updated.type,
    });

    return updated;
  }
}
