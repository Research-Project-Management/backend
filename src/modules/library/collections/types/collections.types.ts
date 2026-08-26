import { Prisma } from '@prisma/client';

export type CollectionId = string & { readonly __brand: 'CollectionId' };
export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' };

export type CollectionDeleteStrategy = 'cascade' | 'move-to-parent' | 'orphan';

export const COLLECTION_INCLUDE_COUNT = {
  _count: {
    select: { catalogItems: { where: { deletedAt: null } } },
  },
} satisfies Prisma.CollectionInclude;

export type CollectionRecord = Prisma.CollectionGetPayload<{
  include: typeof COLLECTION_INCLUDE_COUNT;
}>;

export interface CollectionView {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  parentId: string | null;
  parent: string | null;
  workspaceId: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  itemsCount: number;
}

export interface CollectionNode {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  parentId: string | null;
  itemsCount: number;
  depth: number;
  path: string[];
  children: CollectionNode[];
}

export interface CollectionMoveResult {
  message: string;
  count: number;
  targetCollectionId: string | null;
}

export interface CollectionReorderItem {
  id: string;
  parentId?: string | null;
}
