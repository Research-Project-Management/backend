import { Injectable, Optional } from '@nestjs/common';
import {
  ItemFieldDefinition,
  CreatorTypeDefinition,
  ItemTypeDefinition,
  SchemaRegistrySnapshot,
} from '@/modules/library/core/types/schema.types';
import { SCHEMA_V42_DATA } from '@/modules/library/core/types/schema.constants';
import {
  normalizeCanonicalItemType,
  getEffectiveBaseFieldMap,
  getEffectiveReverseBaseFieldMap,
  normalizeProjectScopeId,
} from '@/modules/library/core';
import { TransactionService } from '@/modules/library/sync';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { ItemQueryService } from './item-query.service';
import { CollectionsService } from './collections.service';
import { SavedSearchesService } from './saved-searches.service';

export interface LibraryBootstrapOptions {
  projectId?: string;
  includeItems?: boolean;
  view?:
    | 'all'
    | 'recent'
    | 'unfiled'
    | 'trash'
    | 'my-publications'
    | 'publications'
    | 'starred'
    | 'retracted';
  collectionId?: string;
  collectionIds?: string[];
  includeSubcollections?: boolean;
  recursive?: boolean;
  tagId?: string;
  tag?: string;
  search?: string;
  searchMode?: 'title_creator_year' | 'fields_tags' | 'everything' | string;
  limit?: number;
  cursor?: string;
  page?: number;
  orderBy?: string;
  orderDirection?: 'asc' | 'desc';
  itemType?: string;
  type?: string;
  fromYear?: number;
  toYear?: number;
  readStatus?: string;
  hasFile?: boolean;
  hasNotes?: boolean;
  fields?: string;
  onlyFlagged?: boolean;
  isRetracted?: boolean;
}

@Injectable()
export class TypesService {
  private readonly snapshot: SchemaRegistrySnapshot = SCHEMA_V42_DATA;

  getVersion(): number {
    return this.snapshot.version;
  }

  getSource(): string {
    return this.snapshot.source;
  }

  getSnapshot(): SchemaRegistrySnapshot {
    return this.snapshot;
  }

  getAllItemTypes(includeSpecial = false): ItemTypeDefinition[] {
    const types = Object.values(this.snapshot.itemTypes);
    if (includeSpecial) {
      return types;
    }
    return types.filter((t: ItemTypeDefinition) => t.isBibliographic);
  }

  getItemType(itemType: string): ItemTypeDefinition | undefined {
    if (!itemType) return undefined;
    const normalized = this.normalizeTypeKey(itemType);
    return this.snapshot.itemTypes[normalized];
  }

  isValidItemType(itemType: string): boolean {
    if (!itemType) return false;
    const normalized = this.normalizeTypeKey(itemType);
    return Object.prototype.hasOwnProperty.call(
      this.snapshot.itemTypes,
      normalized,
    );
  }

  isBibliographic(itemType: string): boolean {
    const def = this.getItemType(itemType);
    return def?.isBibliographic ?? false;
  }

  isSpecial(itemType: string): boolean {
    const def = this.getItemType(itemType);
    return def?.isSpecial ?? false;
  }

  getOrderedFields(itemType: string): ItemFieldDefinition[] {
    const def = this.getItemType(itemType);
    return def ? [...def.fields] : [];
  }

  isValidFieldForType(itemType: string, fieldKey: string): boolean {
    const def = this.getItemType(itemType);
    if (!def) return false;
    return def.fields.some((f: ItemFieldDefinition) => f.key === fieldKey);
  }

  getValidCreatorTypes(itemType: string): CreatorTypeDefinition[] {
    const def = this.getItemType(itemType);
    return def ? [...def.creatorTypes] : [];
  }

  getPrimaryCreatorType(itemType: string): string {
    const def = this.getItemType(itemType);
    return def?.primaryCreatorType ?? 'author';
  }

  isValidCreatorType(itemType: string, creatorType: string): boolean {
    const valid = this.getValidCreatorTypes(itemType);
    return valid.some((c) => c.creatorType === creatorType);
  }

  getBaseFieldMapping(itemType: string): Record<string, string> {
    const normalized = this.normalizeTypeKey(itemType);
    return {
      ...getEffectiveBaseFieldMap(normalized),
      ...(this.snapshot.baseFieldMappings[normalized] || {}),
    };
  }

  getReverseBaseFieldMapping(itemType: string): Record<string, string> {
    const normalized = this.normalizeTypeKey(itemType);
    return {
      ...getEffectiveReverseBaseFieldMap(normalized),
      ...(this.snapshot.reverseBaseFieldMappings[normalized] || {}),
    };
  }

  getBaseFieldFor(itemType: string, fieldKey: string): string | undefined {
    const reverse = this.getReverseBaseFieldMapping(itemType);
    return reverse[fieldKey] || fieldKey;
  }

  getTypeSpecificFieldFor(
    itemType: string,
    baseField: string,
  ): string | undefined {
    const mapping = this.getBaseFieldMapping(itemType);
    return mapping[baseField] || baseField;
  }

  resolveBaseFieldMapping(
    fromType: string,
    toType: string,
    fieldKey: string,
  ): { targetField: string; baseSemantic: string } | undefined {
    const baseField = this.getBaseFieldFor(fromType, fieldKey);
    if (!baseField) return undefined;
    const targetField = this.getTypeSpecificFieldFor(toType, baseField);
    if (!targetField) return undefined;
    return {
      targetField,
      baseSemantic: baseField,
    };
  }

  getAllCreatorRoles(): Record<string, string> {
    return { ...this.snapshot.creatorRoles };
  }

  getDistinctFieldKeys(): string[] {
    return [...this.snapshot.distinctFieldKeys];
  }

  normalizeItemType(rawType: string | undefined | null): string {
    return normalizeCanonicalItemType(rawType, this.snapshot.itemTypes);
  }

  getCslType(itemType: string): string {
    if (!itemType) return 'document';
    const normalized = this.normalizeItemType(itemType);
    return this.snapshot.cslTypeMap?.[normalized] || 'document';
  }

  getCslCreatorRole(creatorType: string): string {
    if (!creatorType) return 'author';
    return this.snapshot.cslCreatorMap?.[creatorType] || creatorType;
  }

  getCslField(field: string): string | undefined {
    return this.snapshot.cslFieldMap?.[field];
  }

  getAllCslTypeMappings(): Record<string, string> {
    return { ...this.snapshot.cslTypeMap };
  }

  getAllCslCreatorMappings(): Record<string, string> {
    return { ...this.snapshot.cslCreatorMap };
  }

  private normalizeTypeKey(key: string): string {
    if (this.snapshot.itemTypes[key]) {
      return key;
    }
    const lower = key.toLowerCase();
    const found = Object.keys(this.snapshot.itemTypes).find(
      (k) => k.toLowerCase() === lower,
    );
    return found || key;
  }
}

@Injectable()
export class LibraryBootstrapService {
  constructor(
    private readonly queryRepo: QueryRepository,
    private readonly itemQueryService: ItemQueryService,
    private readonly collectionsService: CollectionsService,
    private readonly savedSearchesService: SavedSearchesService,
    private readonly typesService: TypesService,
    @Optional() private readonly libraryTx?: TransactionService,
  ) {}

  async getBootstrap(
    userId: string,
    options: LibraryBootstrapOptions = {},
    accessHint?: {
      role?: string;
      permissionOverrides?: Record<string, boolean> | null;
      effectivePermissions?: readonly string[];
    },
  ) {
    const validProjectId = normalizeProjectScopeId(options.projectId);
    const shouldIncludeItems = options.includeItems !== false;
    const syncScope = validProjectId
      ? { projectId: validProjectId }
      : { userId };

    const [
      counts,
      collectionsResult,
      savedSearches,
      latestSeq,
      feedSubscriptions,
      itemsResult,
    ] = await Promise.all([
      this.itemQueryService.getCounts(userId, validProjectId, accessHint),
      this.collectionsService.getCollections(userId, validProjectId),
      this.savedSearchesService.findAll(userId, validProjectId),
      this.libraryTx
        ? this.libraryTx.getLatestSequence(syncScope).catch(() => 0n)
        : Promise.resolve(0n),
      validProjectId
        ? Promise.resolve([])
        : this.queryRepo.findUserFeedSubscriptions(userId),
      shouldIncludeItems
        ? this.itemQueryService.listItems(userId, {
            ...options,
            projectId: validProjectId,
          })
        : Promise.resolve(undefined),
    ]);

    const snapshot = this.typesService.getSnapshot();
    const itemTypesList = this.typesService.getAllItemTypes();

    return {
      scope: validProjectId ? 'project' : 'user',
      scopeId: validProjectId ?? userId,
      counts,
      collections: collectionsResult.collections,
      savedSearches,
      syncVersion: {
        version: latestSeq.toString(),
        scope: validProjectId ? 'project' : 'user',
        scopeId: validProjectId ?? userId,
      },
      itemTypes: {
        success: true,
        schemaVersion: snapshot.version,
        count: itemTypesList.length,
        itemTypes: itemTypesList,
        baseFieldMappings: snapshot.baseFieldMappings,
        creatorRoles: snapshot.creatorRoles,
        cslTypeMap: snapshot.cslTypeMap,
        cslFieldMap: snapshot.cslFieldMap,
      },
      feedSubscriptions,
      ...(itemsResult
        ? {
            items: itemsResult.items,
            pagination: itemsResult.meta,
            meta: itemsResult.meta,
          }
        : {}),
    };
  }
}
