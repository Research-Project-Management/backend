import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { TypesService } from './types.service';
import {
  SchemaValidationResult,
  CreatorHarmonizationChange,
  CreatorTypeDefinition,
  ItemFieldDefinition,
} from '@/modules/library/core/types/schema.types';
import {
  FIELD_ALIASES,
  REVERSE_FIELD_ALIASES,
} from '@/modules/library/core/types/schema.constants';
import {
  CreatorCreditInput,
  ITEM_COLUMN_METADATA_FIELDS,
  INTERNAL_SYSTEM_AND_TELEMETRY_KEYS,
  getEffectiveBaseFieldMap,
  getEffectiveReverseBaseFieldMap,
  getValidCreatorMapForType,
} from '@/modules/library/core';

const SYSTEM_AND_TELEMETRY_KEYS = new Set([
  ...INTERNAL_SYSTEM_AND_TELEMETRY_KEYS,
  'id',
  'projectId',
  'userId',
  'createdById',
  'uploadedById',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'version',
  'expectedVersion',
  'isDeleted',
  'silent',
  'provenance',
  'fieldProvenance',
  'lockedFields',
  'ingestionStatus',
  'verificationScore',
  'isVerified',
  'matchedSignals',
  'missingFields',
  'isSelfSufficient',
  'qualityScore',
  'engineUsed',
  'disambiguationWarning',
  'rejectedCitedDoi',
  'promptUploadPdf',
  'sourceProvider',
  'source',
  'sources',
  'originProvider',
  'canonicalId',
  'canonicalUrl',
  'resolvedAt',
  'warnings',
  'dismissedDuplicateIds',
  'mergedFromIds',
  'crossrefEnriched',
  'isRetracted',
  'retractionNature',
  'retractionDetails',
  'retractionCheckedAt',
  'isMyPublication',
  'publicationConfirmedAt',
  'userStates',
  'states',
  'readStatus',
  'rating',
  'lastReadAt',
  'isStarred',
  'isFavorite',
  'demotedToExtra',
  'demotedExtraLines',
  '__demotedExtraLines',
  '__isSystemUpdate',
  '__updateSource',
]);

const UNIVERSAL_FIELDS = new Set([
  ...SYSTEM_AND_TELEMETRY_KEYS,
  ...ITEM_COLUMN_METADATA_FIELDS,
  ...Object.keys(FIELD_ALIASES),
  ...Object.values(FIELD_ALIASES),
  'creators',
  'authors',
  'author',
  'editors',
  'contributors',
  'metadata',
  'relations',
  'seeAlso',
  'tags',
  'labels',
  'itemTags',
  'keywords',
  'keywordsList',
  'collectionId',
  'collectionIds',
  'collections',
  'collectionItems',
  'notes',
  'notesList',
  'fileUrl',
  'fileId',
  'filename',
  'mimeType',
  'size',
  'primaryFile',
  'attachments',
  'identifiers',
  'extraFields',
  'URL',
  'numberOfPages',
  'numPages',
  'journalRef',
  'primaryCategory',
  'categories',
]);

@Injectable()
export class ZoteroSchemaValidatorService {
  private readonly logger = new Logger(ZoteroSchemaValidatorService.name);

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
            serviceCreatorTypes.map((c: CreatorTypeDefinition) => [
              c.creatorType.toLowerCase(),
              c.creatorType,
            ]),
          )
        : getValidCreatorMapForType(itemType);
    const primaryCreatorRaw = this.typesService.getPrimaryCreatorType(itemType);
    const primaryCreator =
      validCreatorMap.get(primaryCreatorRaw.toLowerCase()) || primaryCreatorRaw;

    const changes: CreatorHarmonizationChange[] = [];
    const harmonizedCreators = creators.map((c, index) => {
      if (!c || typeof c !== 'object') return c;
      const rawRole = (c.creatorType || 'author').trim();
      const lowerRole = rawRole.toLowerCase();

      const canonicalRole = validCreatorMap.get(lowerRole);
      if (canonicalRole) {
        return {
          ...c,
          creatorType: canonicalRole,
        };
      }

      let targetRole = primaryCreator;
      let reason: CreatorHarmonizationChange['reason'] =
        'normalized-to-primary';

      const contributorCanonical = validCreatorMap.get('contributor');
      if (index > 0 && contributorCanonical) {
        targetRole = contributorCanonical;
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
