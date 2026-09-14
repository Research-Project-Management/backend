import {
  ItemMetadata,
  ItemSummary as ItemDomainSummary,
} from '../types/items.types';

export interface ItemSnapshot {
  id: string;
  userId?: string;
  title: string;
  abstract?: string | null;
  year?: number | null;
  doi?: string | null;
  citationKey?: string | null;
  publicationTitle?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  issn?: string | null;
  isbn?: string | null;
  url?: string | null;
  tags: string[];
}

export interface ItemSummary {
  id: string;
  userId?: string;
  title: string;
  itemType?: string | null;
  version?: number;
  updatedAt?: Date;
}

export type SyncItemSnapshot = ItemSnapshot;
export type SyncItemSummary = ItemSummary;

export interface ItemDetail extends ItemMetadata {
  id: string;
  userId?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export interface CreateItemCommand {
  userId: string;
  metadata: ItemMetadata;
}

export interface UpdateItemCommand {
  userId: string;
  itemId: string;
  metadata: Partial<ItemMetadata>;
  expectedVersion?: number;
}

export interface QualityAuditCandidateItem {
  id: string;
  title: string;
  doi: string | null;
  abstract: string | null;
  year: number | null;
  contributors: Array<{ id: string }>;
  publicationTitle: string | null;
}

export interface DuplicateCandidateItem {
  id: string;
  title: string;
  doi: string | null;
  isbn: string | null;
  issn: string | null;
  pmid: string | null;
  citationKey: string | null;
  year: number | null;
  contributors: Array<{
    fullName: string;
    firstName: string | null;
    lastName: string | null;
    orderIndex: number;
  }>;
}

export interface IItemReadPort {
  findById(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<ItemDetail | null>;
  findByIds(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<ItemDetail[]>;
  findByDoi(
    userId: string,
    doi: string,
    projectId?: string,
  ): Promise<ItemDetail | null>;
  findSummaryById(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<ItemDomainSummary | null>;
  findSummariesByIds(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<ItemDomainSummary[]>;
  getItemSnapshot(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<SyncItemSnapshot | null>;
  getItemSnapshots(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<SyncItemSummary[]>;
  findQualityAuditItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<QualityAuditCandidateItem[]>;
  findDuplicateCandidateItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<DuplicateCandidateItem[]>;
}

export const ITEM_READ_PORT = Symbol('ITEM_READ_PORT');

export interface IItemExistencePort {
  exists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean>;
  assertExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<void>;
  existMany(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<Map<string, boolean>>;
}

export const ITEM_EXISTENCE_PORT = Symbol('ITEM_EXISTENCE_PORT');

export const ITEM_NOTES_EXTRACTOR_PORT = Symbol('ITEM_NOTES_EXTRACTOR_PORT');

export interface IItemNotesExtractorPort {
  extractNotesFromAnnotations(
    userId: string,
    itemId: string,
  ): Promise<unknown>;
}
