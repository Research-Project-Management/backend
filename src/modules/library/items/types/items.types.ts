import { Prisma } from '@prisma/client';
import { CreatorInput as LibraryCreatorInput } from '../../metadata/types/metadata.types';

export type ItemId = string & { readonly __brand: 'ItemId' };
export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' };

export const ITEM_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} satisfies Prisma.UserSelect;

export const ITEM_INCLUDE = {
  uploadedBy: {
    select: ITEM_USER_SELECT,
  },
  collection: true,
  attachments: true,
} satisfies Prisma.CatalogItemInclude;

export type ItemRecord = Prisma.CatalogItemGetPayload<{
  include: typeof ITEM_INCLUDE;
}>;

export type ItemView = ItemRecord & {
  creators: LibraryCreatorInput[];
  tags: string[];
  abstractNote: string;
  date: string;
};

export interface ItemListQuery {
  collectionId?: string;
  search?: string;
  smartFilter?: string;
  limit?: number;
  skip?: number;
}

export interface ItemPagination {
  limit: number;
  skip: number;
  totalItems: number;
  hasNextPage: boolean;
}

export interface ItemListResult {
  data: ItemView[];
  items: ItemView[];
  papers: ItemView[];
  total: number;
  pagination: ItemPagination;
}

export interface ItemResponse {
  item: ItemView;
  paper: ItemView;
}

// Backward-compatible aliases
export type LibraryItemId = ItemId;
export const LIBRARY_ITEM_USER_SELECT = ITEM_USER_SELECT;
export const LIBRARY_ITEM_INCLUDE = ITEM_INCLUDE;
export type LibraryItemRecord = ItemRecord;
export type CatalogItemWithRelations = ItemRecord;
export type LibraryItemView = ItemView;
export type LibraryItemListQuery = ItemListQuery;
export type LibraryItemPagination = ItemPagination;
export type LibraryItemListResult = ItemListResult;
export type LibraryItemResponse = ItemResponse;
