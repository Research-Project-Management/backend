import { ItemFieldDefinition } from '@/modules/library/shared-kernel/types/schema.types';

export const CATALOG_FACADE = 'CATALOG_FACADE';

export interface ICatalogFacade {
  getItem<T = unknown>(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<T | null>;
  getItemSummary<T = unknown>(
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
  createItem<T = unknown, D = Record<string, unknown>>(
    userId: string,
    data: D,
    options?: Record<string, unknown>,
    projectId?: string,
  ): Promise<T>;
  updateItem<T = unknown, D = Record<string, unknown>>(
    userId: string,
    itemId: string,
    data: D,
    options?: { expectedVersion?: number; projectId?: string },
  ): Promise<T>;
  deleteItem(userId: string, itemId: string, projectId?: string): Promise<void>;
  findByIds<T = unknown>(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<T[]>;
  countItems(
    userId: string,
    options?: Record<string, unknown>,
  ): Promise<number>;
  findMany<T = unknown>(
    userId: string,
    options?: Record<string, unknown>,
  ): Promise<T[]>;
  validateItemType?(type: string): Promise<boolean>;
  getPrimaryCreatorType?(itemType: string): string;
  getOrderedFields?(itemType: string): ItemFieldDefinition[];
  findQualityAuditItems<T = unknown>(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<T[]>;
  findDuplicateCandidateItems<T = unknown>(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<T[]>;
  mergeItems?(
    tx: unknown,
    duplicateItemIds: string[],
    primaryItemId: string,
  ): Promise<unknown>;
  createNote?<T = unknown, D = Record<string, unknown>>(
    userId: string,
    data: D,
  ): Promise<T>;
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
      score: number;
      reasons: string[];
      doi?: string | null;
      arxivId?: string | null;
      pmid?: string | null;
      isbn?: string | null;
      year?: number | null;
      itemType?: string | null;
      authors?: string[];
      creators?: unknown[];
    }>;
  }>;
  [key: string]: unknown;
}
