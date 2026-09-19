import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { TypesService } from '../types.service';
import {
  SchemaValidationResult,
  CreatorHarmonizationChange,
} from '../types/schema.types';
import {
  FIELD_ALIASES,
  REVERSE_FIELD_ALIASES,
} from '../constants/types.constants';

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

  /**
   * Validates and normalizes item type key. Throws BadRequestException if unregistered.
   */
  validateItemType(rawType?: string | null): string {
    const normalized = this.typesService.normalizeItemType(rawType);
    if (!this.typesService.isValidItemType(normalized)) {
      throw new BadRequestException(
        `Invalid itemType '${rawType}'. Must be one of registered Zotero schema types.`,
      );
    }
    return normalized;
  }

  /**
   * Harmonizes creator roles against valid creator types for the given itemType.
   * If a creator role is invalid for the type (e.g. 'author' for 'patent'),
   * it falls back to the type's primary creator (e.g. 'inventor') or 'contributor',
   * recording a traceable change event.
   */
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
        .map((c) => c.creatorType.toLowerCase()),
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
        // Already valid for this itemType
        return {
          ...c,
          creatorType: lowerRole,
        };
      }

      // Role is not valid for this itemType. Harmonize predictably.
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

  /**
   * Validates fields for the given itemType.
   * If a field does not belong to this itemType and is not a universal field,
   * it is safely demoted into the Zotero plain-text `extra` field (`Key: Value`)
   * ensuring ZERO DATA LOSS while keeping the top-level entity strictly schema-compliant.
   */
  validateAndSanitizeFields(
    itemType: string,
    data: Record<string, any>,
  ): {
    cleanFields: Record<string, any>;
    demotedToExtra: Record<string, any>;
    warnings: string[];
  } {
    const validFields = new Set(
      this.typesService.getOrderedFields(itemType).map((f) => f.key),
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

      // 1. Check if universal field
      if (UNIVERSAL_FIELDS.has(key)) {
        cleanFields[key] = value;
        continue;
      }

      // 2. Check if valid field directly or via alias
      const canonicalAlias = FIELD_ALIASES[key] || REVERSE_FIELD_ALIASES[key];
      const isValidDirect = validFields.has(key);
      const isValidAlias = canonicalAlias && validFields.has(canonicalAlias);

      if (isValidDirect || isValidAlias) {
        cleanFields[key] = value;
        continue;
      }

      // 3. Field is not valid for this itemType. Demote to extra for zero data loss.
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

  /**
   * Complete schema validation and sanitization pipeline for an item.
   */
  validateAndSanitizeItem(
    rawType: string | undefined | null,
    rawData: Record<string, any>,
  ): SchemaValidationResult {
    const itemType = this.validateItemType(
      rawType || rawData.itemType || rawData.type,
    );
    const { creators, changes } = this.validateAndHarmonizeCreators(
      itemType,
      rawData.creators,
    );

    const dataWithCreators = {
      ...rawData,
      itemType,
      type: itemType,
      creators,
    };

    const { cleanFields, demotedToExtra, warnings } =
      this.validateAndSanitizeFields(itemType, dataWithCreators);

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
