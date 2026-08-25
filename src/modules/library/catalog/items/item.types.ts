import { Prisma } from '@prisma/client';

export type LibraryItemId = string & { readonly __brand: 'LibraryItemId' };
export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' };

export const LIBRARY_ITEM_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} satisfies Prisma.UserSelect;

export const LIBRARY_ITEM_INCLUDE = {
  uploadedBy: {
    select: LIBRARY_ITEM_USER_SELECT,
  },
  collection: true,
  attachments: true,
} satisfies Prisma.CatalogItemInclude;

export type LibraryItemRecord = Prisma.CatalogItemGetPayload<{
  include: typeof LIBRARY_ITEM_INCLUDE;
}>;

export interface LibraryItemListQuery {
  collectionId?: string;
  search?: string;
  smartFilter?: string;
  limit?: number;
  skip?: number;
}

export interface LibraryItemPagination {
  limit: number;
  skip: number;
  totalItems: number;
  hasNextPage: boolean;
}

export interface LibraryItemListResult {
  data: LibraryItemRecord[];
  items: LibraryItemRecord[];
  papers: LibraryItemRecord[];
  total: number;
  pagination: LibraryItemPagination;
}

export interface LibraryItemResponse {
  item: LibraryItemRecord;
  paper: LibraryItemRecord;
}
