import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { TypesService } from './types.service';
import {
  SchemaValidationResult,
  CreatorHarmonizationChange,
} from '../../shared-kernel/types/schema.types';
import {
  FIELD_ALIASES,
  REVERSE_FIELD_ALIASES,
} from '../../shared-kernel/types/schema.constants';

const UNIVERSAL_FIELDS = new Set([
  'id',
  'title',
  'itemType',
  'type',
  'projectId',
  'creators',
  'authors',
  'editors',
  'contributors',
  'tags',
  'labels',
  'keywords',
  'keywordsList',
  'collectionId',
  'collectionIds',
  'collections',
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
  'doi',
  'DOI',
  'arxivId',
  'archiveID',
  'archiveId',
  'pmid',
  'PMID',
  'pmcid',
  'PMCID',
  'isbn',
  'ISBN',
  'issn',
  'ISSN',
  'url',
  'URL',
  'extra',
  'extraFields',
  'citationKey',
  'citeKey',
  'citationCount',
  'referenceCount',
  'openAccessPdfUrl',
  'uploadedById',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'expectedVersion',
  'provenance',
  'userStates',
  'states',
  'readStatus',
  'rating',
  'lastReadAt',
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
    creators?: any[],
  ): {
    creators: any[];
    changes: CreatorHarmonizationChange[];
  } {
    if (!Array.isArray(creators) || creators.length === 0) {
      return { creators: [], changes: [] };
    }

    const validCreatorTypes = new Set(
      this.typesService
        .getValidCreatorTypes(itemType)
        .map((c: any) => c.creatorType.toLowerCase()),
    );
    const primaryCreator = this.typesService
      .getPrimaryCreatorType(itemType)
      .toLowerCase();

    const changes: CreatorHarmonizationChange[] = [];
    const harmonizedCreators = creators.map((c, index) => {
      if (!c || typeof c !== 'object') return c;
      const rawRole = (c.creatorType || 'author').trim();
      const lowerRole = rawRole.toLowerCase();

      if (validCreatorTypes.has(lowerRole)) {
        return {
          ...c,
          creatorType: lowerRole,
        };
      }

      let targetRole = primaryCreator;
      let reason: CreatorHarmonizationChange['reason'] =
        'normalized-to-primary';

      if (index > 0 && validCreatorTypes.has('contributor')) {
        targetRole = 'contributor';
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
    data: Record<string, any>,
  ): {
    cleanFields: Record<string, any>;
    demotedToExtra: Record<string, any>;
    warnings: string[];
  } {
    const validFields = new Set(
      this.typesService.getOrderedFields(itemType).map((f: any) => f.key),
    );

    const cleanFields: Record<string, any> = {};
    const demotedToExtra: Record<string, any> = {};
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

      if (UNIVERSAL_FIELDS.has(key)) {
        cleanFields[key] = value;
        continue;
      }

      const canonicalAlias = FIELD_ALIASES[key] || REVERSE_FIELD_ALIASES[key];
      const isValidDirect = validFields.has(key);
      const isValidAlias = canonicalAlias && validFields.has(canonicalAlias);

      if (isValidDirect || isValidAlias) {
        cleanFields[key] = value;
        continue;
      }

      demotedToExtra[key] = value;
      const warningMsg = `[SchemaTrace] Field '${key}' is not part of Zotero schema for itemType '${itemType}'; safely demoting to 'extra'`;
      this.logger.warn(warningMsg);
      warnings.push(warningMsg);

      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
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
    rawData: Record<string, any>,
  ): SchemaValidationResult {
    const itemType = this.validateItemType(
      rawType || rawData.itemType || rawData.type,
    );

    let creators = rawData.creators;
    let changes: CreatorHarmonizationChange[] = [];
    if (rawData.creators !== undefined) {
      const harm = this.validateAndHarmonizeCreators(
        itemType,
        rawData.creators,
      );
      creators = harm.creators;
      changes = harm.changes;
    }

    const dataWithCreators: Record<string, any> = {
      ...rawData,
      itemType,
      type: itemType,
      ...(rawData.creators !== undefined ? { creators } : {}),
    };

    const { cleanFields, demotedToExtra, warnings } =
      this.validateAndSanitizeFields(itemType, dataWithCreators);

    if (rawData.creators === undefined) {
      delete cleanFields.creators;
    }
    if (
      rawData.itemType === undefined &&
      rawData.type === undefined &&
      !rawType
    ) {
      delete cleanFields.itemType;
      delete cleanFields.type;
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
