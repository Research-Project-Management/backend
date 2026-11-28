/**
 * modules/pages/structure/domain/structure.ports.ts
 * Domain parameter types for Page Virtual Tree nodes.
 */

import { PageNodeType } from './node.entity';

export interface CreateNodeParams {
  projectId: string;
  pageId?: string | null;
  parentId?: string | null;
  type: PageNodeType;
  name: string;
  path: string;
  docId?: string | null;
  fileId?: string | null;
  isRootDoc?: boolean;
  sizeBytes?: number;
  hash?: string | null;
  sortOrder?: number;
}
