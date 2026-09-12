export * from '../library.facade';
export * from '../../sync/types/sync.types';

export interface LibraryStats {
  itemsCount: number;
  collectionsCount: number;
  tagsCount: number;
  notesCount: number;
  attachmentsCount: number;
  storageBytes?: number;
}

export interface LibraryOverview {
  recentItems: any[];
  unfiledCount: number;
  trashCount: number;
  starredCount: number;
  topTags: Array<{ id: string; name: string; color?: string | null; count: number }>;
}

export type CoreStats = LibraryStats;
export type CoreOverview = LibraryOverview;
