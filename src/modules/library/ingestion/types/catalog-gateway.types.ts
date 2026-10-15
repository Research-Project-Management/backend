import { Prisma } from '@prisma/client';
import {
  ItemDetail,
  DuplicateCandidateItem,
  CreateItemData,
  UpdateItemData,
  NoteEntity,
  CreateNoteData,
} from '@/modules/library/catalog';
import { ItemFieldDefinition } from '@/modules/library/shared-kernel';

export const CATALOG_GATEWAY_PORT = Symbol('CATALOG_GATEWAY_PORT');

export interface ICatalogGatewayPort {
  getItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<ItemDetail | null>;
  createItem(
    userId: string,
    data: CreateItemData,
    options?: {
      expectedVersion?: number;
      suppressIndexing?: boolean;
      projectId?: string;
      source?: string;
      idempotencyKey?: string;
      correlationId?: string;
    },
    projectId?: string,
  ): Promise<ItemDetail>;
  updateItem(
    userId: string,
    itemId: string,
    data: UpdateItemData,
    expectedVersion?: number,
    projectId?: string,
  ): Promise<ItemDetail>;
  deleteItem(userId: string, itemId: string, projectId?: string): Promise<void>;
  findDuplicateCandidateItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<DuplicateCandidateItem[]>;
  findByIds(
    userId: string,
    ids: string[],
    projectId?: string,
  ): Promise<ItemDetail[]>;
  mergeItems(
    tx: Prisma.TransactionClient,
    duplicateItemIds: string[],
    primaryItemId: string,
  ): Promise<void>;
  findQualityAuditItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<ItemDetail[]>;
  getOrderedFields?(itemType: string): ItemFieldDefinition[];
  getPrimaryCreatorType?(itemType: string): string;
  createNote?(userId: string, data: CreateNoteData): Promise<NoteEntity>;
  itemExists?(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean>;
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
