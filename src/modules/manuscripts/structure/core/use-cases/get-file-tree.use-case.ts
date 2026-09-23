/**
 * modules/manuscripts/structure/core/use-cases/get-file-tree.use-case.ts
 * Builds a hierarchical nested tree (TreeNodeDto) for client IDE sidebar.
 */

import { Injectable } from '@nestjs/common';
import { IStructureRepository } from '../ports/structure-repository.port';
import { ManuscriptNodeEntity } from '../domain/manuscript-node.entity';
import { TreeNodeDto } from '../../dto/node.dto';

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
    const nodeMap = new Map<string, TreeNodeDto>();
    const rootNodes: TreeNodeDto[] = [];

    // 1. Initialize tree node DTOs
    for (const node of nodes) {
      nodeMap.set(node.id, {
        id: node.id,
        name: node.name,
        path: node.path,
        type: node.type,
        depth: node.depth,
        isRootDoc: node.isRootDoc,
        docId: node.docId,
        fileId: node.fileId,
        sizeBytes: node.sizeBytes,
        hash: node.hash,
        sortOrder: node.sortOrder,
        children: [],
      });
    }

    // 2. Build parent-child relationships
    for (const node of nodes) {
      const treeNode = nodeMap.get(node.id)!;
      if (node.parentId && nodeMap.has(node.parentId)) {
        nodeMap.get(node.parentId)!.children.push(treeNode);
      } else {
        rootNodes.push(treeNode);
      }
    }

    // 3. Sort nodes recursively: FOLDERS first, then DOCs & FILEs, then alphabetical
    const sortFn = (a: TreeNodeDto, b: TreeNodeDto): number => {
      if (a.type === 'FOLDER' && b.type !== 'FOLDER') return -1;
      if (a.type !== 'FOLDER' && b.type === 'FOLDER') return 1;
      if (a.isRootDoc && !b.isRootDoc) return -1;
      if (!a.isRootDoc && b.isRootDoc) return 1;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.name.localeCompare(b.name);
    };

    const sortRecursively = (list: TreeNodeDto[]) => {
      list.sort(sortFn);
      for (const item of list) {
        if (item.children.length > 0) {
          sortRecursively(item.children);
        }
      }
    };

    sortRecursively(rootNodes);
    return rootNodes;
  }
}
