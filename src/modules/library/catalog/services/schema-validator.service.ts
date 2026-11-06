import { Injectable, Logger, BadRequestException, Optional } from '@nestjs/common';
import { RedisCacheService } from '@/core';
import { SchemaValidationResult, CreatorHarmonizationChange, CreatorTypeDefinition, ItemFieldDefinition, ItemTypeDefinition, SchemaRegistrySnapshot } from '@/modules/library/core/types/schema.types';
import { FIELD_ALIASES, REVERSE_FIELD_ALIASES, SCHEMA_V42_DATA } from '@/modules/library/core/types/schema.constants';
import { CreatorCreditInput, getEffectiveBaseFieldMap, getEffectiveReverseBaseFieldMap, getValidCreatorMapForType, normalizeCanonicalItemType, normalizeProjectScopeId, libraryConfig, invalidateLibraryScopeCaches } from '@/modules/library/core';
import {
  PRIVILEGED_INTERNAL_KEYS,
  SYSTEM_AND_TELEMETRY_KEYS,
  UNIVERSAL_FIELDS,
} from '@/modules/library/catalog/types/catalog.types';

@Injectable()
export class TypesService {
  private readonly snapshot: SchemaRegistrySnapshot = SCHEMA_V42_DATA;

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



  normalizeItemType(rawType: string | undefined | null): string {
    return normalizeCanonicalItemType(rawType, this.snapshot.itemTypes);
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
export class SchemaValidatorService {
  private readonly logger = new Logger(SchemaValidatorService.name);

  constructor(private readonly typesService: TypesService) {}

  validateItemType(rawType?: string | null): string {
    const normalized = this.typesService.normalizeItemType(rawType);
    if (!this.typesService.isValidItemType(normalized)) {
      throw new BadRequestException(
        `Invalid itemType '${rawType}'. Must be one of registered Zotero schema types.`,
      );
    }
    return normalized;
  }

  validateAndHarmonizeCreators(
    itemType: string,
    creators?: CreatorCreditInput[],
  ): {
    creators: CreatorCreditInput[];
    changes: CreatorHarmonizationChange[];
  } {
    if (!Array.isArray(creators) || creators.length === 0) {
      return { creators: [], changes: [] };
    }

    const serviceCreatorTypes =
      this.typesService.getValidCreatorTypes(itemType);
    const validCreatorMap =
      Array.isArray(serviceCreatorTypes) && serviceCreatorTypes.length > 0
        ? new Map(
            serviceCreatorTypes.flatMap((c: CreatorTypeDefinition) => {
              const lower = c.creatorType.toLowerCase();
              const snake = c.creatorType
                .replace(/([A-Z])/g, '_$1')
                .toLowerCase();
              return [
                [lower, c.creatorType] as const,
                [snake, c.creatorType] as const,
              ];
            }),
          )
        : getValidCreatorMapForType(itemType);
    const primaryCreatorRaw = this.typesService.getPrimaryCreatorType(itemType);
    const primaryCreator =
      validCreatorMap.get(primaryCreatorRaw.toLowerCase()) || primaryCreatorRaw;

    const CREATOR_SYNONYMS: Record<string, string> = {
      primary_author: 'author',
      primaryauthor: 'author',
      corresponding_author: 'author',
      correspondingauthor: 'author',
      first_author: 'author',
      firstauthor: 'author',
      co_author: 'author',
      coauthor: 'author',
      'co-author': 'author',
      advisor: 'contributor',
      supervisor: 'contributor',
      thesis_advisor: 'contributor',
      thesisadvisor: 'contributor',
    };

    const PRIMARY_CREATOR_ROLES = new Set([
      'author',
      'inventor',
      'director',
      'artist',
      'cartographer',
      'interviewee',
      'podcaster',
      'presenter',
      'programmer',
      'sponsor',
    ]);

    const changes: CreatorHarmonizationChange[] = [];
    const harmonizedCreators = creators.map((c, index) => {
      if (!c || typeof c !== 'object') return c;
      const rawRole = (c.creatorType || 'author').trim();
      const lowerRole = rawRole.toLowerCase();
      const effectiveRole = CREATOR_SYNONYMS[lowerRole] ?? lowerRole;

      const canonicalRole =
        validCreatorMap.get(lowerRole) ?? validCreatorMap.get(effectiveRole);
      if (canonicalRole && canonicalRole === rawRole) {
        return {
          ...c,
          creatorType: canonicalRole,
        };
      }
      if (canonicalRole && lowerRole === effectiveRole) {
        return {
          ...c,
          creatorType: canonicalRole,
        };
      }

      let targetRole = canonicalRole || primaryCreator;
      let reason: CreatorHarmonizationChange['reason'] =
        'normalized-to-primary';

      const contributorCanonical = validCreatorMap.get('contributor');
      const isPrimaryLike = PRIMARY_CREATOR_ROLES.has(effectiveRole);
      if (
        !canonicalRole &&
        !isPrimaryLike &&
        index > 0 &&
        contributorCanonical
      ) {
        targetRole = contributorCanonical;
        reason = 'fallback-to-contributor';
      } else if (canonicalRole && effectiveRole === 'contributor') {
        targetRole = canonicalRole;
        reason = 'fallback-to-contributor';
      }

      const creatorName =
        c.fullName ||
        c.name ||
        [c.firstName, c.lastName].filter(Boolean).join(' ') ||
        `Creator #${index + 1}`;

      this.logger.log(
        `[SchemaTrace] Harmonized creator '${creatorName}' from '${rawRole}' to '${targetRole}' for itemType '${itemType}' (${reason})`,
      );

      changes.push({
        index,
        originalName: creatorName,
        fromRole: rawRole,
        toRole: targetRole,
        reason,
      });

      return {
        ...c,
        creatorType: targetRole,
      };
    });

    return { creators: harmonizedCreators, changes };
  }

  validateAndSanitizeFields(
    itemType: string,
    data: Record<string, unknown>,
  ): {
    cleanFields: Record<string, unknown>;
    demotedToExtra: Record<string, unknown>;
    warnings: string[];
  } {
    const validFields = new Set(
      this.typesService
        .getOrderedFields(itemType)
        .map((f: ItemFieldDefinition) => f.key),
    );
    const typeBaseMap = getEffectiveBaseFieldMap(itemType);
    const typeReverseBaseMap = getEffectiveReverseBaseFieldMap(itemType);
    const mappedMediumField = typeBaseMap.medium;

    const cleanFields: Record<string, unknown> = {};
    const demotedToExtra: Record<string, unknown> = {};
    const warnings: string[] = [];

    const extraLines: string[] = [];
    const demotedExtraLines: string[] = [];
    if (typeof data.extra === 'string' && data.extra.trim()) {
      extraLines.push(data.extra.trim());
    }

    for (const [key, value] of Object.entries(data)) {
      if (PRIVILEGED_INTERNAL_KEYS.has(key)) {
        continue;
      }
      if (value === undefined || value === null || value === '') {
        cleanFields[key] = value;
        continue;
      }

      if (
        SYSTEM_AND_TELEMETRY_KEYS.has(key) ||
        UNIVERSAL_FIELDS.has(key) ||
        (key === 'type' &&
          typeof value === 'string' &&
          value.trim().toLowerCase() === itemType.toLowerCase())
      ) {
        cleanFields[key] = value;
        continue;
      }

      const canonicalAlias = FIELD_ALIASES[key] || REVERSE_FIELD_ALIASES[key];
      const mappedBase =
        typeBaseMap[key] ||
        typeReverseBaseMap[key] ||
        (canonicalAlias
          ? typeBaseMap[canonicalAlias] || typeReverseBaseMap[canonicalAlias]
          : undefined);

      const isValidDirect = validFields.has(key);
      const isValidAlias = Boolean(
        canonicalAlias && validFields.has(canonicalAlias),
      );
      const isValidMappedBase = Boolean(
        (mappedBase && validFields.has(mappedBase)) ||
        (key === 'type' &&
          mappedMediumField &&
          validFields.has(mappedMediumField)),
      );

      if (isValidDirect || isValidAlias || isValidMappedBase) {
        cleanFields[key] = value;
        continue;
      }

      demotedToExtra[key] = value;
      const warningMsg = `[SchemaTrace] Field '${key}' is not part of Zotero schema for itemType '${itemType}'; safely demoting to 'extra'`;
      this.logger.debug(warningMsg);
      warnings.push(warningMsg);

      if (
        !SYSTEM_AND_TELEMETRY_KEYS.has(key) &&
        (typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean')
      ) {
        const line = `${key}: ${value}`;
        if (!extraLines.some((l) => l.startsWith(`${key}:`))) {
          extraLines.push(line);
        }
        if (!demotedExtraLines.some((l) => l.startsWith(`${key}:`))) {
          demotedExtraLines.push(line);
        }
      }
    }

    if (
      cleanFields.extraFields &&
      typeof cleanFields.extraFields === 'object' &&
      !Array.isArray(cleanFields.extraFields)
    ) {
      const sanitizedExtraFields = {
        ...(cleanFields.extraFields as Record<string, unknown>),
      };
      for (const pk of PRIVILEGED_INTERNAL_KEYS) {
        delete sanitizedExtraFields[pk];
      }
      cleanFields.extraFields = sanitizedExtraFields;
    }

    // Map single string `author` into `authors: [author]` if `creators`/`contributors`/`authors` are not provided
    if (
      typeof cleanFields.author === 'string' &&
      cleanFields.author.trim() &&
      cleanFields.creators === undefined &&
      cleanFields.contributors === undefined &&
      cleanFields.authors === undefined
    ) {
      cleanFields.authors = [cleanFields.author.trim()];
    }

    if (demotedExtraLines.length > 0) {
      cleanFields.demotedExtraLines = demotedExtraLines;
      cleanFields.demotedToExtra = demotedToExtra;
    }

    // Only emit `extra` when the client sent it or fields were demoted into it; otherwise
    // an empty string would wipe the stored extra on every PATCH.
    if (data.extra !== undefined) {
      cleanFields.extra =
        data.extra === null || data.extra === '' ? '' : extraLines.join('\n');
    } else if (extraLines.length > 0) {
      cleanFields.extra = extraLines.join('\n');
    }

    return { cleanFields, demotedToExtra, warnings };
  }

  validateAndSanitizeItem(
    rawType: string | undefined | null,
    rawData: Record<string, unknown>,
  ): SchemaValidationResult {
    const itemType = this.validateItemType(
      rawType ||
        (rawData.itemType as string | undefined) ||
        (typeof rawData.type === 'string' &&
        this.typesService.isValidItemType(rawData.type.trim())
          ? rawData.type.trim()
          : undefined),
    );

    let creators = rawData.creators as CreatorCreditInput[] | undefined;
    let changes: CreatorHarmonizationChange[] = [];
    if (rawData.creators !== undefined) {
      const harm = this.validateAndHarmonizeCreators(
        itemType,
        rawData.creators as CreatorCreditInput[],
      );
      creators = harm.creators;
      changes = harm.changes;
    }

    const hasExplicitItemType = Boolean(
      rawType || typeof rawData.itemType === 'string',
    );
    let resolvedTypeVal: string | null | undefined = itemType;
    if (rawData.type === null) {
      resolvedTypeVal = null;
    } else if (typeof rawData.type === 'string') {
      const trimmedType = rawData.type.trim();
      if (trimmedType === '') {
        resolvedTypeVal = '';
      } else if (
        trimmedType.toLowerCase() !== itemType.toLowerCase() &&
        (hasExplicitItemType || !this.typesService.isValidItemType(trimmedType))
      ) {
        resolvedTypeVal = trimmedType;
      }
    }

    const dataWithCreators: Record<string, unknown> = {
      ...rawData,
      itemType,
      type: resolvedTypeVal,
      ...(rawData.creators !== undefined ? { creators } : {}),
    };

    const { cleanFields, demotedToExtra, warnings } =
      this.validateAndSanitizeFields(itemType, dataWithCreators);

    if (rawData.creators === undefined) {
      delete cleanFields.creators;
    }

    return {
      valid: true,
      itemType,
      sanitizedItem: cleanFields,
      warnings,
      demotedToExtra,
      creatorChanges: changes,
    };
  }
}

/**
 * ItemCacheCoordinator
 * Encapsulates Redis caching and invalidation logic across Item scopes, details, and fulltext entries.
 */
@Injectable()
export class ItemCacheCoordinator {
  private readonly logger = new Logger(ItemCacheCoordinator.name);
  private readonly isTestEnv = libraryConfig().app.isTest;

  constructor(@Optional() private readonly cache?: RedisCacheService) {}

  /**
   * Invalidates Redis cache entries for an item and affected library lists.
   */
  async invalidateItemCache(
    id: string,
    userId?: string,
    projectId?: string,
    options?: {
      skipScopeInvalidation?: boolean;
      onlyUserStateOverlay?: boolean;
      preserveContentCaches?: boolean;
    },
  ): Promise<void> {
    if (!this.cache) return;
    try {
      await invalidateLibraryScopeCaches(this.cache, {
        userId,
        projectId,
        itemIds: [id],
        skipScopeInvalidation:
          options?.skipScopeInvalidation === true || !userId,
        onlyUserStateOverlay: options?.onlyUserStateOverlay,
        preserveContentCaches: options?.preserveContentCaches,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to invalidate cache for item ${id}: ${message}`);
    }
  }

  /**
   * Performs a single scope-level cache invalidation for list/count/tag caches.
   */
  async invalidateScopeListCache(
    userId: string,
    projectId?: string,
  ): Promise<void> {
    if (!this.cache) return;
    try {
      await invalidateLibraryScopeCaches(this.cache, {
        userId,
        projectId,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to invalidate scope caches: ${message}`);
    }
  }

  /**
   * Batch invalidates Redis cache entries across multiple items and scopes.
   */
  async invalidateBulkItemsCache(
    itemIds: string[],
    userId: string,
    projectId?: string,
    additionalProjectIds?: Array<string | null | undefined>,
    options?: {
      skipScopeInvalidation?: boolean;
      onlyUserStateOverlay?: boolean;
      preserveContentCaches?: boolean;
    },
  ): Promise<void> {
    if (itemIds.length === 0 || !this.cache) return;
    try {
      await invalidateLibraryScopeCaches(this.cache, {
        userId,
        projectId,
        itemIds,
        additionalProjectIds,
        skipScopeInvalidation: options?.skipScopeInvalidation,
        onlyUserStateOverlay: options?.onlyUserStateOverlay,
        preserveContentCaches: options?.preserveContentCaches,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to invalidate bulk item caches (${itemIds.length} items): ${message}`,
      );
    }
  }

  /**
   * Unified write-path invalidation helper for item mutations across services.
   */
  async invalidateForWrite(params: {
    userId: string;
    projectId?: string | null;
    itemIds?: string[];
    additionalProjectIds?: Array<string | null | undefined>;
    skipScopeInvalidation?: boolean;
    onlyUserStateOverlay?: boolean;
    preserveContentCaches?: boolean;
  }): Promise<void> {
    const validProjectId = normalizeProjectScopeId(
      params.projectId ?? undefined,
    );
    if (params.itemIds && params.itemIds.length > 0) {
      await this.invalidateBulkItemsCache(
        params.itemIds,
        params.userId,
        validProjectId,
        params.additionalProjectIds,
        {
          skipScopeInvalidation: params.skipScopeInvalidation,
          onlyUserStateOverlay: params.onlyUserStateOverlay,
          preserveContentCaches: params.preserveContentCaches,
        },
      );
      return;
    }
    if (!params.skipScopeInvalidation) {
      await this.invalidateScopeListCache(params.userId, validProjectId);
    }
  }
}
