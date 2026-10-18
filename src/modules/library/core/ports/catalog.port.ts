import type { Prisma } from '@prisma/client';
import { ItemFieldDefinition } from '@/modules/library/core/types/schema.types';
import {
  ItemDetail,
  ItemSummary,
  CreateItemData,
  UpdateItemData,
  QualityAuditCandidateItem,
  DuplicateCandidateItem,
  CreateNoteData,
  NoteEntity,
} from '@/modules/library/core/types/bibliographic.types';

export const CATALOG_FACADE = 'CATALOG_FACADE';

export interface ICatalogFacade {
  getItem<T = ItemDetail>(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<T | null>;
  getItemSummary<T = ItemSummary>(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<T | null>;
  itemExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean>;
  getTags<T = unknown>(
    userId: string,
    options?: { includeInactive?: boolean; projectId?: string },
  ): Promise<T[]>;
  getItemState<T = unknown>(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<T | null>;
  createItem<T = ItemDetail, D = CreateItemData>(
    userId: string,
    data: D,
    options?: Record<string, unknown>,
    projectId?: string,
  ): Promise<T>;
  updateItem<T = ItemDetail, D = UpdateItemData>(
    userId: string,
    itemId: string,
    data: D,
    options?: { expectedVersion?: number; projectId?: string },
  ): Promise<T>;
  deleteItem(userId: string, itemId: string, projectId?: string): Promise<void>;
  findByIds<T = ItemDetail>(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<T[]>;
  countItems(
    userId: string,
    options?: Record<string, unknown>,
  ): Promise<number>;
  findMany<T = ItemDetail>(
    userId: string,
    options?: Record<string, unknown>,
  ): Promise<T[]>;
  validateItemType?(type: string): Promise<boolean>;
  getPrimaryCreatorType?(itemType: string): string;
  getOrderedFields?(itemType: string): ItemFieldDefinition[];
  findQualityAuditItems<T = QualityAuditCandidateItem>(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<T[]>;
  findDuplicateCandidateItems<T = DuplicateCandidateItem>(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<T[]>;
  mergeItems(
    tx: Prisma.TransactionClient,
    duplicateItemIds: string[],
    primaryItemId: string,
  ): Promise<unknown>;
  createNote?(userId: string, data: CreateNoteData): Promise<NoteEntity>;
  listNotes?(
    userId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<NoteEntity[]>;
  listCollections?(userId: string, projectId?: string): Promise<unknown[]>;
  findMatchCandidates?(
    scope: { userId?: string; projectId?: string | null } | string,
    criteria: {
      doi?: string | null;
      arxivId?: string | null;
      pmid?: string | null;
      isbn?: string | null;
      titleWords?: string[];
      titlePrefix?: string;
    },
  ): Promise<{
    exactMatch?: {
      id: string;
      title: string;
      matchReason: 'DOI_EXACT' | 'ARXIV_EXACT' | 'PMID_EXACT' | 'ISBN_EXACT';
      evidence: Record<string, unknown>;
    } | null;
    candidateItems: Array<{
      id: string;
      title: string;
      score?: number;
      reasons?: string[];
      doi?: string | null;
      arxivId?: string | null;
      pmid?: string | null;
      isbn?: string | null;
      year?: number | null;
      itemType?: string | null;
      authors?: string[];
      citationKey?: string | null;
      creators?: unknown[];
    }>;
  }>;
}
