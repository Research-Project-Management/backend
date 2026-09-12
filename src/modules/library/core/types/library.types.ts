import { Item, Contributor } from '@prisma/client';

export type RecentLibraryItem = Item & {
  contributors: Contributor[];
};

export interface LibraryItemSummary {
  id: string;
  title: string;
  doi?: string | null;
  abstract?: string | null;
  year?: number | null;
  itemType: string;
  authors: string[];
}

export interface LibraryStats {
  itemsCount: number;
  collectionsCount: number;
  tagsCount: number;
  notesCount: number;
  attachmentsCount: number;
  storageBytes?: number;
}

export interface LibraryOverview {
  recentItems: RecentLibraryItem[];
  unfiledCount: number;
  trashCount: number;
  starredCount: number;
  topTags: Array<{
    id: string;
    name: string;
    color?: string | null;
    count: number;
  }>;
}
