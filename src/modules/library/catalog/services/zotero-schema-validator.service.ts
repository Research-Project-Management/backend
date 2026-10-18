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
  BASE_FIELD_MAPPINGS,
  REVERSE_BASE_FIELD_MAPPINGS,
  SCHEMA_V42_DATA,
} from '@/modules/library/core/types/schema.constants';
import {
  CreatorCreditInput,
  ITEM_COLUMN_METADATA_FIELDS,
  getValidCreatorMapForType,
} from '@/modules/library/core';

const SYSTEM_AND_TELEMETRY_KEYS = new Set([
  'id',
  'projectId',
  'workspaceId',
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
  'ingestionStatus',
  'verificationScore',
  'isVerified',
  'matchedSignals',
  'missingFields',
  'isSelfSufficient',
  'qualityScore',
  'engineUsed',
  'dismissedDuplicateIds',
  'mergedFromIds',
  'crossrefEnriched',
  'ragDocId',
  'ragIndexedAt',
  'ragLastAttemptAt',
  'ragAttempts',
  'ragError',
  'ragStatus',
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
]);

const UNIVERSAL_FIELDS = new Set([
  ...SYSTEM_AND_TELEMETRY_KEYS,
  ...SCHEMA_V42_DATA.distinctFieldKeys,
  ...ITEM_COLUMN_METADATA_FIELDS,
  ...Object.keys(FIELD_ALIASES),
  ...Object.values(FIELD_ALIASES),
  'creators',
  'authors',
  'editors',
  'contributors',
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
  'chapter',
  'chapterNumber',
  'formatType',
  'priorityDate',
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
    const typeBaseMap = BASE_FIELD_MAPPINGS[itemType] || {};
    const typeReverseBaseMap = REVERSE_BASE_FIELD_MAPPINGS[itemType] || {};

    const cleanFields: Record<string, unknown> = {};
    const demotedToExtra: Record<string, unknown> = {};
    const warnings: string[] = [];

    const extraLines: string[] = [];
    if (typeof data.extra === 'string' && data.extra.trim()) {
      extraLines.push(data.extra.trim());
    }

    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || value === null || value === '') {
        cleanFields[key] = value;
        continue;
      }

      if (SYSTEM_AND_TELEMETRY_KEYS.has(key) || UNIVERSAL_FIELDS.has(key)) {
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
        mappedBase && validFields.has(mappedBase),
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
      }
    }

    cleanFields.extra = extraLines.join('\n');

    return { cleanFields, demotedToExtra, warnings };
  }

  validateAndSanitizeItem(
    rawType: string | undefined | null,
    rawData: Record<string, unknown>,
  ): SchemaValidationResult {
    const itemType = this.validateItemType(
      rawType ||
        (rawData.itemType as string | undefined) ||
        (rawData.type as string | undefined),
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

    const rawTypeFieldVal =
      typeof rawData.type === 'string' &&
      rawData.type.trim().toLowerCase() !== itemType.toLowerCase() &&
      !this.typesService.isValidItemType(rawData.type.trim())
        ? rawData.type.trim()
        : undefined;

    const dataWithCreators: Record<string, unknown> = {
      ...rawData,
      itemType,
      type: rawTypeFieldVal ?? itemType,
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
