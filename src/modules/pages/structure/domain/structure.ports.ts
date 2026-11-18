/**
 * modules/pages/structure/domain/structure.ports.ts
 * Port interfaces for Page Virtual Tree nodes, root doc detection, and tree mutation broadcasts.
 */

import { ManuscriptNodeEntity, ManuscriptNodeType } from './node.entity';

export interface CreateNodeParams {
  projectId: string;
  pageId?: string | null;
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
  abstract findById(
    projectId: string,
    nodeId: string,
  ): Promise<ManuscriptNodeEntity | null>;
  abstract findByPath(
    projectId: string,
    path: string,
    pageId?: string | null,
  ): Promise<ManuscriptNodeEntity | null>;
  abstract findByFileId?(
    projectId: string,
    fileId: string,
    pageId?: string | null,
  ): Promise<ManuscriptNodeEntity | null>;
  abstract getAllNodes(
    projectId: string,
    pageId?: string | null,
  ): Promise<ManuscriptNodeEntity[]>;
  abstract getRootDoc(
    projectId: string,
    pageId?: string | null,
  ): Promise<ManuscriptNodeEntity | null>;
  abstract setRootDoc(projectId: string, nodeId: string): Promise<void>;
  abstract unsetRootDoc(
    projectId: string,
    pageId?: string | null,
  ): Promise<void>;
  abstract moveSubtree(
    projectId: string,
    sourcePath: string,
    destPath: string,
    newParentId: string | null,
    options?: { nodeId?: string; pageId?: string | null },
  ): Promise<void>;
  abstract renameNode(
    projectId: string,
    nodeId: string,
    newName: string,
    newPath: string,
  ): Promise<ManuscriptNodeEntity>;
  abstract deleteSubtree(
    projectId: string,
    path: string,
    pageId?: string | null,
  ): Promise<ManuscriptNodeEntity[]>;
  abstract updateSortOrder(
    projectId: string,
    nodeId: string,
    sortOrder: number,
  ): Promise<void>;
  abstract updateNodeFileId?(
    projectId: string,
    nodeId: string,
    fileId: string,
    sizeBytes?: number,
    hash?: string | null,
  ): Promise<ManuscriptNodeEntity>;
  abstract countNodes(
    projectId: string,
    pageId?: string | null,
  ): Promise<number>;
  abstract docExistsInProject?(
    projectId: string,
    docId: string,
    pageId?: string | null,
  ): Promise<boolean>;
  abstract fileExistsInProject?(
    projectId: string,
    fileId: string,
    pageId?: string | null,
  ): Promise<boolean>;
}
