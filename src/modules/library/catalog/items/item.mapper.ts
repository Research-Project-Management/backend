import {
  LibraryItemListResult,
  LibraryItemRecord,
  LibraryItemResponse,
} from './item.types';

export function toLibraryItemResponse(
  item: LibraryItemRecord,
): LibraryItemResponse {
  return { item, paper: item };
}

export function toLibraryItemListResult(
  items: LibraryItemRecord[],
  total: number,
  options?: {
    limit?: number;
    skip?: number;
  },
): LibraryItemListResult {
  const limit = options?.limit ?? items.length;
  const skip = options?.skip ?? 0;

  return {
    data: items,
    items,
    papers: items,
    total,
    pagination: {
      limit,
      skip,
      totalItems: total,
      hasNextPage: skip + items.length < total,
    },
  };
}
