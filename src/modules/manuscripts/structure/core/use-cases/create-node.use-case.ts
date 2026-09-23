/**
 * modules/manuscripts/structure/core/use-cases/create-node.use-case.ts
 * Creates a new file, document, or folder node with auto-mkdirp support.
 */

import { Injectable } from '@nestjs/common';
import { IStructureRepository } from '../ports/structure-repository.port';
import { ITreePublisher } from '../ports/tree-publisher.port';
import { ManuscriptNodeEntity, ManuscriptNodeType } from '../domain/manuscript-node.entity';
import { NodePathVo } from '../domain/node-path.vo';
import { DuplicateNodePathError, NodeNotFoundError } from '../domain/structure-errors';
import { CreateNodeDto } from '../../dto/node.dto';

@Injectable()
export class CreateNodeUseCase {
  constructor(
    private readonly structureRepository: IStructureRepository,
    private readonly treePublisher: ITreePublisher
  ) {}

  public async execute(projectId: string, dto: CreateNodeDto): Promise<ManuscriptNodeEntity> {
    NodePathVo.validateFilename(dto.name);

    // 1. Resolve full virtual path and parent node
    let parentNode: ManuscriptNodeEntity | null = null;
    let computedPath: string;

    if (dto.parentId) {
      parentNode = await this.structureRepository.findById(projectId, dto.parentId);
      if (!parentNode) {
        throw new NodeNotFoundError(dto.parentId);
      }
      computedPath = NodePathVo.join(parentNode.path, dto.name);
    } else if (dto.path) {
      computedPath = NodePathVo.normalize(dto.path);
      const dirname = NodePathVo.dirname(computedPath);
      if (dirname !== '/') {
        parentNode = await this.mkdirp(projectId, dirname);
      }
    } else {
      computedPath = NodePathVo.join('/', dto.name);
    }

    // 2. Check if node already exists at computedPath
    const existing = await this.structureRepository.findByPath(projectId, computedPath);
    if (existing) {
      throw new DuplicateNodePathError(computedPath);
    }

    // 3. Create node
    const node = await this.structureRepository.createNode({
      projectId,
      parentId: parentNode ? parentNode.id : null,
      type: dto.type,
      name: dto.name,
      path: computedPath,
      docId: dto.docId,
      fileId: dto.fileId,
      isRootDoc: dto.isRootDoc ?? false,
    });

    // 4. If marked as rootDoc, update repository
    if (dto.isRootDoc && dto.type === 'DOC') {
      await this.structureRepository.setRootDoc(projectId, node.id);
    }

    // 5. Publish mutation
    await this.treePublisher.publishTreeMutation({
      projectId,
      action: 'create',
      nodeId: node.id,
      path: node.path,
      entityType: node.type,
    });

    return node;
  }

  /**
   * Recursively ensures parent directories exist, creating them as FOLDER nodes if missing.
   */
  public async mkdirp(projectId: string, dirPath: string): Promise<ManuscriptNodeEntity> {
    const normalized = NodePathVo.normalize(dirPath);
    if (normalized === '/') {
      throw new Error('Cannot mkdirp root directory');
    }

    const segments = normalized.split('/').filter(Boolean);
    let currentPath = '';
    let parentNode: ManuscriptNodeEntity | null = null;

    for (const segment of segments) {
      currentPath = NodePathVo.join(currentPath, segment);
      let found = await this.structureRepository.findByPath(projectId, currentPath);

      if (!found) {
        found = await this.structureRepository.createNode({
          projectId,
          parentId: parentNode ? parentNode.id : null,
          type: 'FOLDER',
          name: segment,
          path: currentPath,
        });

        await this.treePublisher.publishTreeMutation({
          projectId,
          action: 'create',
          nodeId: found.id,
          path: found.path,
          entityType: 'FOLDER',
        });
      }

      parentNode = found;
    }

    return parentNode!;
  }
}
