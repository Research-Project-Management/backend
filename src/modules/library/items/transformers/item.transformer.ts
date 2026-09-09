import { Injectable, BadRequestException } from '@nestjs/common';
import { TypesService } from '../../types/types.service';
import { ItemsMapper } from '../mappers/items.mapper';
import {
  TypeConversionPreview,
  FieldMappingChange,
  DroppedField,
  CreatorRoleChange,
} from '../types/items.types';
import {
  CATALOG_COLUMN_METADATA_FIELDS,
  FIELD_ALIASES,
  REVERSE_FIELD_ALIASES,
} from '../constants/items.constants';
import { ItemFieldDefinition } from '../../types/types/types.types';

/**
 * ItemTransformer — Deep Module for item metadata projections and conversions (Matt Pocock Pattern).
 * Encapsulates field alias resolutions, semantic base-mappings, dropped field collections,
 * and creator role fallbacks behind a concise, pure deterministic interface.
 */
@Injectable()
export class ItemTransformer {
  constructor(private readonly typesService: TypesService) {}

  /**
   * Helper to retrieve field value taking into account direct properties,
   * extraFields, and alias mappings.
   */
  getItemFieldValue(item: Record<string, any>, key: string): any {
    if (!item) return undefined;
    if (item[key] !== undefined && item[key] !== null && item[key] !== '') {
      return item[key];
    }
    if (item.extraFields && typeof item.extraFields === 'object') {
      if (
        item.extraFields[key] !== undefined &&
        item.extraFields[key] !== null &&
        item.extraFields[key] !== ''
      ) {
        return item.extraFields[key];
      }
    }
    const alias = FIELD_ALIASES[key] || REVERSE_FIELD_ALIASES[key];
    if (alias) {
      if (
        item[alias] !== undefined &&
        item[alias] !== null &&
        item[alias] !== ''
      ) {
        return item[alias];
      }
      if (item.extraFields && typeof item.extraFields === 'object') {
        if (
          item.extraFields[alias] !== undefined &&
          item.extraFields[alias] !== null &&
          item.extraFields[alias] !== ''
        ) {
          return item.extraFields[alias];
        }
      }
    }
    const lowerKey = key.toLowerCase();
    for (const [k, v] of Object.entries(item)) {
      if (
        k.toLowerCase() === lowerKey &&
        v !== undefined &&
        v !== null &&
        v !== ''
      ) {
        return v;
      }
    }
    if (item.extraFields && typeof item.extraFields === 'object') {
      for (const [k, v] of Object.entries(item.extraFields)) {
        if (
          k.toLowerCase() === lowerKey &&
          v !== undefined &&
          v !== null &&
          v !== ''
        ) {
          return v;
        }
      }
    }
    return undefined;
  }

  /**
   * Helper to find matching target field in target item type schema.
   */
  findMatchingTargetField(
    sourceKey: string,
    targetFields: ItemFieldDefinition[],
  ): string | undefined {
    const exact = targetFields.find((f) => f.key === sourceKey);
    if (exact) return exact.key;

    const targetAlias =
      FIELD_ALIASES[sourceKey] || REVERSE_FIELD_ALIASES[sourceKey];
    if (targetAlias) {
      const matched = targetFields.find((f) => f.key === targetAlias);
      if (matched) return matched.key;
    }

    const lowerSource = sourceKey.toLowerCase();
    const matchedCase = targetFields.find(
      (f) => f.key.toLowerCase() === lowerSource,
    );
    if (matchedCase) return matchedCase.key;

    return undefined;
  }

  /**
   * Generates a deterministic preview of item-type conversion without modifying DB state.
   */
  previewConversion(
    rawItem: Record<string, any>,
    targetType: string,
    options: { retainUnmappedInExtra?: boolean } = {},
  ): TypeConversionPreview {
    const item = ItemsMapper.toDomain(rawItem);
    const sourceType = item.itemType || item.type || 'journalArticle';

    if (!this.typesService.isValidType(targetType)) {
      throw new BadRequestException(`Invalid target itemType: ${targetType}`);
    }

    if (!this.typesService.isBibliographic(sourceType)) {
      throw new BadRequestException(
        `Cannot convert non-bibliographic item type: ${sourceType}`,
      );
    }

    if (!this.typesService.isBibliographic(targetType)) {
      throw new BadRequestException(
        `Cannot convert to special non-bibliographic item type: ${targetType}`,
      );
    }

    if (sourceType === targetType) {
      return {
        sourceType,
        targetType,
        preservedFields: this.typesService
          .getOrderedFields(sourceType)
          .map((f) => f.key),
        mappedFields: [],
        droppedFields: [],
        creatorChanges: (item.creators || []).map(
          (c: Record<string, unknown>) => ({
            creator: c,
            fromRole: c.creatorType || 'author',
            toRole: c.creatorType || 'author',
            reason: 'preserved' as const,
          }),
        ),
        projectedItem: { ...item },
        unmappedRetained: {},
        hasLoss: false,
      };
    }

    const sourceFields = this.typesService.getOrderedFields(sourceType);
    const targetFields = this.typesService.getOrderedFields(targetType);
    const targetFieldKeys = new Set(targetFields.map((f) => f.key));
    const sourceLabelMap = new Map(sourceFields.map((f) => [f.key, f.label]));

    const preservedFields: string[] = [];
    const mappedFields: FieldMappingChange[] = [];
    const droppedFields: DroppedField[] = [];
    const unmappedRetained: Record<string, any> = {};

    const projectedItem: Record<string, any> = {
      ...item,
      itemType: targetType,
      type: targetType,
    };

    const sourceValues: Record<string, any> = {};
    for (const field of sourceFields) {
      const val = this.getItemFieldValue(item, field.key);
      if (val !== undefined && val !== null && val !== '') {
        sourceValues[field.key] = val;
      }
    }

    const persistentAcademicKeys = [
      'title',
      'abstract',
      'abstractNote',
      'date',
      'year',
      'url',
      'DOI',
      'doi',
      'ISBN',
      'isbn',
      'ISSN',
      'issn',
      'PMID',
      'pmid',
      'PMCID',
      'pmcid',
      'archiveID',
      'archiveId',
      'arxivId',
      'citationCount',
      'referenceCount',
      'openAccessPdfUrl',
      'language',
      'shortTitle',
      'rights',
      'license',
      'extra',
      'citationKey',
    ];
    for (const k of persistentAcademicKeys) {
      const val = this.getItemFieldValue(item, k);
      if (val !== undefined && val !== null && val !== '') {
        const canonicalKey = FIELD_ALIASES[k]
          ? k
          : REVERSE_FIELD_ALIASES[k] || k;
        if (
          sourceValues[canonicalKey] === undefined &&
          sourceValues[k] === undefined
        ) {
          sourceValues[canonicalKey] = val;
        }
      }
    }

    for (const field of sourceFields) {
      const matched = this.findMatchingTargetField(field.key, targetFields);
      if (
        !matched &&
        field.key !== 'title' &&
        field.key !== 'abstract' &&
        field.key !== 'abstractNote' &&
        field.key !== 'url' &&
        field.key !== 'doi' &&
        field.key !== 'DOI'
      ) {
        delete projectedItem[field.key];
      }
    }

    const newExtraFields: Record<string, any> = { ...(item.extraFields || {}) };

    if (sourceType === 'book' && targetType === 'bookSection') {
      if (sourceValues.title) {
        projectedItem.bookTitle = sourceValues.title;
        projectedItem.title = '';
        mappedFields.push({
          fromField: 'title',
          toField: 'bookTitle',
          value: sourceValues.title,
          rule: 'special-rule',
        });
        delete sourceValues.title;
      }
      delete projectedItem.shortTitle;
      delete sourceValues.shortTitle;
    } else if (sourceType === 'bookSection' && targetType === 'book') {
      if (sourceValues.bookTitle) {
        const chapterTitle = sourceValues.title;
        projectedItem.title = sourceValues.bookTitle;
        mappedFields.push({
          fromField: 'bookTitle',
          toField: 'title',
          value: sourceValues.bookTitle,
          rule: 'special-rule',
        });
        delete sourceValues.bookTitle;
        delete sourceValues.title;

        if (chapterTitle) {
          droppedFields.push({
            field: 'sectionTitle',
            label: 'Section Title',
            value: chapterTitle,
          });
          unmappedRetained.sectionTitle = chapterTitle;
          if (options.retainUnmappedInExtra !== false) {
            newExtraFields[`__unmapped_${sourceType}_sectionTitle`] =
              chapterTitle;
          }
        }
      }
      delete projectedItem.shortTitle;
      delete sourceValues.shortTitle;
    }

    for (const [sField, val] of Object.entries(sourceValues)) {
      const matchedTargetKey = this.findMatchingTargetField(sField, targetFields);
      if (matchedTargetKey) {
        projectedItem[matchedTargetKey] = val;
        const dbCol = FIELD_ALIASES[matchedTargetKey];
        if (dbCol) projectedItem[dbCol] = val;
        preservedFields.push(matchedTargetKey);
      } else {
        const resolved = this.typesService.resolveBaseFieldMapping(
          sourceType,
          targetType,
          sField,
        );

        if (
          resolved?.targetField &&
          targetFieldKeys.has(resolved.targetField)
        ) {
          projectedItem[resolved.targetField] = val;
          const dbCol = FIELD_ALIASES[resolved.targetField];
          if (dbCol) projectedItem[dbCol] = val;
          mappedFields.push({
            fromField: sField,
            toField: resolved.targetField,
            value: val,
            rule: 'base-semantic',
          });
        } else {
          const isPersistentCol =
            CATALOG_COLUMN_METADATA_FIELDS.has(sField) ||
            CATALOG_COLUMN_METADATA_FIELDS.has(FIELD_ALIASES[sField]);

          if (
            isPersistentCol &&
            [
              'doi',
              'DOI',
              'arxivId',
              'archiveID',
              'archiveId',
              'pmid',
              'PMID',
              'pmcid',
              'PMCID',
              'citationCount',
              'referenceCount',
              'openAccessPdfUrl',
              'url',
            ].includes(sField)
          ) {
            projectedItem[sField] = val;
            const dbCol = FIELD_ALIASES[sField];
            if (dbCol) projectedItem[dbCol] = val;
            preservedFields.push(sField);
          } else {
            droppedFields.push({
              field: sField,
              label: sourceLabelMap.get(sField) || sField,
              value: val,
            });
            unmappedRetained[sField] = val;

            if (options.retainUnmappedInExtra !== false) {
              newExtraFields[`__unmapped_${sourceType}_${sField}`] = val;
            }
          }
        }
      }
    }

    projectedItem.extraFields = newExtraFields;

    const validCreatorRoles = new Set(
      this.typesService
        .getValidCreatorTypes(targetType)
        .map((c) => c.creatorType),
    );
    const targetPrimaryCreator =
      this.typesService.getPrimaryCreatorType(targetType);
    const creatorChanges: CreatorRoleChange[] = [];

    const projectedCreators = (item.creators || []).map(
      (c: Record<string, unknown>, index: number) => {
        const fromRole = (c.creatorType as string) || 'author';
        let toRole: string = fromRole;
        let reason: 'preserved' | 'primary-fallback' | 'secondary-fallback' =
          'preserved';

        if (!validCreatorRoles.has(fromRole)) {
          if (index === 0 && validCreatorRoles.has(targetPrimaryCreator)) {
            toRole = targetPrimaryCreator;
            reason = 'primary-fallback';
          } else if (validCreatorRoles.has('contributor')) {
            toRole = 'contributor';
            reason = 'secondary-fallback';
          } else {
            toRole = targetPrimaryCreator;
            reason = 'primary-fallback';
          }
        }

        creatorChanges.push({ creator: c, fromRole, toRole, reason });
        return { ...c, creatorType: toRole };
      },
    );

    projectedItem.creators = projectedCreators;

    const hasLoss =
      droppedFields.length > 0 ||
      creatorChanges.some((c) => c.reason !== 'preserved');

    return {
      sourceType,
      targetType,
      preservedFields: Array.from(new Set(preservedFields)),
      mappedFields,
      droppedFields,
      creatorChanges,
      projectedItem,
      unmappedRetained,
      hasLoss,
    };
  }
}
