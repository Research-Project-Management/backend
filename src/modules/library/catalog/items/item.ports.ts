import { Prisma } from '@prisma/client';
import {
  LibraryItemId,
  LibraryItemListQuery,
  LibraryItemListResult,
  LibraryItemRecord,
  LibraryItemResponse,
  WorkspaceId,
} from './item.types';

export interface LibraryItemReadPort {
  listItems(
    workspaceId: WorkspaceId | string,
    query?: LibraryItemListQuery,
  ): Promise<LibraryItemListResult>;

  getItemById(itemId: LibraryItemId | string): Promise<LibraryItemResponse>;
}

export interface LibraryItemWritePort {
  updateItem(
    itemId: LibraryItemId | string,
    data:
      Prisma.CatalogItemUpdateInput | Prisma.CatalogItemUncheckedUpdateInput,
  ): Promise<LibraryItemRecord>;
}
