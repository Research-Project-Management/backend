import { ItemMetadata, ItemSummary as ItemDomainSummary } from '../types/items.types';

export interface ItemSnapshot {
  id: string;
  workspaceId: string;
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
  title: string;
  itemType?: string | null;
  version?: number;
  updatedAt?: Date;
}

export type SyncItemSnapshot = ItemSnapshot;
export type SyncItemSummary = ItemSummary;

export interface ItemDetail extends ItemMetadata {
  id: string;
  workspaceId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export interface CreateItemCommand {
  workspaceId: string;
  userId: string;
  metadata: ItemMetadata;
}

export interface UpdateItemCommand {
  workspaceId: string;
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
    workspaceId: string,
    itemId: string,
  ): Promise<ItemDetail | null>;
  findByIds(
    workspaceId: string,
    itemIds: string[],
  ): Promise<ItemDetail[]>;
  findByDoi(
    workspaceId: string,
    doi: string,
  ): Promise<ItemDetail | null>;
  findSummaryById(
    workspaceId: string,
    itemId: string,
  ): Promise<ItemDomainSummary | null>;
  findSummariesByIds(
    workspaceId: string,
    itemIds: string[],
  ): Promise<ItemDomainSummary[]>;
  getItemSnapshot(
    workspaceId: string,
    itemId: string,
  ): Promise<SyncItemSnapshot | null>;
  getItemSnapshots(
    workspaceId: string,
    itemIds: string[],
  ): Promise<SyncItemSummary[]>;
  findQualityAuditItems(
    workspaceId: string,
    limit?: number,
  ): Promise<QualityAuditCandidateItem[]>;
  findDuplicateCandidateItems(
    workspaceId: string,
    limit?: number,
  ): Promise<DuplicateCandidateItem[]>;
}

export const ITEM_READ_PORT = Symbol('ITEM_READ_PORT');

export interface IItemExistencePort {
  exists(workspaceId: string, itemId: string): Promise<boolean>;
  assertExists(workspaceId: string, itemId: string): Promise<void>;
  existMany(
    workspaceId: string,
    itemIds: string[],
  ): Promise<Map<string, boolean>>;
}

export const ITEM_EXISTENCE_PORT = Symbol('ITEM_EXISTENCE_PORT');

export const ITEM_NOTES_EXTRACTOR_PORT = Symbol('ITEM_NOTES_EXTRACTOR_PORT');

export interface IItemNotesExtractorPort {
  extractNotesFromAnnotations(
    workspaceId: string,
    itemId: string,
    userId: string,
  ): Promise<unknown>;
}
