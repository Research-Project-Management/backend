import {
  ItemListResult,
  ItemRecord,
  ItemResponse,
  ItemView,
} from './types/items.types';

export function toItemResponse(item: ItemRecord): ItemResponse {
  const view = toItemView(item);
  return { item: view, paper: view };
}

export function toItemListResult(
  items: ItemRecord[],
  total: number,
  options?: {
    limit?: number;
    skip?: number;
  },
): ItemListResult {
  const limit = options?.limit ?? items.length;
  const skip = options?.skip ?? 0;
  const views = items.map(toItemView);

  return {
    data: views,
    items: views,
    papers: views,
    total,
    pagination: {
      limit,
      skip,
      totalItems: total,
      hasNextPage: skip + items.length < total,
    },
  };
}

export function toItemView(item: ItemRecord): ItemView {
  const creators = [
    ...(item.authors ?? []).map((name: string) => ({
      creatorType: 'author',
      name,
    })),
    ...(item.editors ?? []).map((name: string) => ({
      creatorType: 'editor',
      name,
    })),
  ];

  return {
    ...item,
    creators,
    tags: item.labels ?? [],
    abstractNote: item.abstract ?? '',
    date: item.publicationDate ?? (item.year ? String(item.year) : ''),
  };
}

// Backward-compatible aliases
export const toLibraryItemResponse = toItemResponse;
export const toLibraryItemListResult = toItemListResult;
export const toLibraryItemView = toItemView;
