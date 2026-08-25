import {
  LibraryItemListResult,
  LibraryItemRecord,
  LibraryItemResponse,
  LibraryItemView,
} from './item.types';

export function toLibraryItemResponse(
  item: LibraryItemRecord,
): LibraryItemResponse {
  const view = toLibraryItemView(item);
  return { item: view, paper: view };
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
  const views = items.map(toLibraryItemView);

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

export function toLibraryItemView(item: LibraryItemRecord): LibraryItemView {
  const creators = [
    ...(item.authors ?? []).map((name) => ({
      creatorType: 'author',
      name,
    })),
    ...(item.editors ?? []).map((name) => ({
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
