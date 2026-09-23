/**
 * modules/manuscripts/structure/core/ports/structure-repository.port.ts
 * Port interface for persistence of Manuscript File Tree nodes.
 */

import { ManuscriptNodeEntity, ManuscriptNodeType } from '../domain/manuscript-node.entity';

export interface CreateNodeParams {
  projectId: string;
  parentId?: string | null;
  type: ManuscriptNodeType;
  name: string;
  path: string;
  docId?: string | null;
  fileId?: string | null;
  isRootDoc?: boolean;
  sizeBytes?: number;
  hash?: string | null;
  sortOrder?: number;
}

export abstract class IStructureRepository {
  abstract createNode(params: CreateNodeParams): Promise<ManuscriptNodeEntity>;
  abstract findById(projectId: string, nodeId: string): Promise<ManuscriptNodeEntity | null>;
  abstract findByPath(projectId: string, path: string): Promise<ManuscriptNodeEntity | null>;
  abstract getAllNodes(projectId: string): Promise<ManuscriptNodeEntity[]>;
  abstract getRootDoc(projectId: string): Promise<ManuscriptNodeEntity | null>;
  abstract setRootDoc(projectId: string, nodeId: string): Promise<void>;
  abstract unsetRootDoc(projectId: string): Promise<void>;
  abstract moveSubtree(
    projectId: string,
    sourcePath: string,
    destPath: string,
    newParentId: string | null
  ): Promise<void>;
  abstract renameNode(
    projectId: string,
    nodeId: string,
    newName: string,
    newPath: string
  ): Promise<ManuscriptNodeEntity>;
  abstract deleteSubtree(projectId: string, path: string): Promise<ManuscriptNodeEntity[]>;
  abstract updateSortOrder(projectId: string, nodeId: string, sortOrder: number): Promise<void>;
}
