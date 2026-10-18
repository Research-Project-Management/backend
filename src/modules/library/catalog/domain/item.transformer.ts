import { Injectable, BadRequestException } from '@nestjs/common';
import { TypesService } from '@/modules/library/catalog/services/types.service';
import { ItemsMapper } from './items.mapper';
import {
  TypeConversionPreview,
  FieldMappingChange,
  DroppedField,
  CreatorRoleChange,
} from '@/modules/library/catalog/types/items.types';
import {
  ITEM_COLUMN_METADATA_FIELDS,
  FIELD_ALIASES,
  REVERSE_FIELD_ALIASES,
} from '@/modules/library/catalog/types/items.constants';
import {
  ItemFieldDefinition,
  CreatorTypeDefinition,
} from '@/modules/library/core/types/schema.types';

export interface IItemTransformerPort {
  getItemFieldValue(item: Record<string, unknown>, key: string): unknown;
  findMatchingTargetField(
    sourceKey: string,
    targetFields: ItemFieldDefinition[],
  ): string | undefined;
  previewConversion(
    rawItem: unknown,
    targetType: string,
    options?: { retainUnmappedInExtra?: boolean },
  ): TypeConversionPreview;
}

/**
 * ItemTransformer — Deep Module for item metadata projections and conversions.
 * Encapsulates field alias resolutions, semantic base-mappings, dropped field collections,
 * and creator role fallbacks behind a concise, pure deterministic interface.
 */
@Injectable()
export class ItemTransformer implements IItemTransformerPort {
  constructor(private readonly typesService: TypesService) {}

  /**
   * Helper to retrieve field value taking into account direct properties,
   * extraFields, and alias mappings.
   */
  getItemFieldValue(item: Record<string, unknown>, key: string): unknown {
    if (!item) return undefined;
    if (item[key] !== undefined && item[key] !== null && item[key] !== '') {
      return item[key];
    }
    if (item.extraFields && typeof item.extraFields === 'object') {
      const extra = item.extraFields as Record<string, unknown>;
      if (
        extra[key] !== undefined &&
        extra[key] !== null &&
        extra[key] !== ''
      ) {
        return extra[key];
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
        const ef = item.extraFields as Record<string, unknown>;
        if (ef[alias] !== undefined && ef[alias] !== null && ef[alias] !== '') {
          return ef[alias];
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
    rawItem: unknown,
    targetType: string,
    options: { retainUnmappedInExtra?: boolean } = {},
  ): TypeConversionPreview {
    const item = ItemsMapper.toDomain(rawItem) as Record<string, unknown>;
    const sourceType = (item.itemType ||
      item.type ||
      'journalArticle') as string;

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
          .map((f: ItemFieldDefinition) => f.key),
        mappedFields: [],
        droppedFields: [],
        newAvailableFields: [],
        creatorChanges: (
          (Array.isArray(item.creators) ? item.creators : []) as Array<
            Record<string, unknown>
          >
        ).map((c: Record<string, unknown>) => ({
          creator: c,
          fromRole: (c.creatorType as string) || 'author',
          toRole: (c.creatorType as string) || 'author',
          reason: 'preserved' as const,
        })),
        projectedItem: { ...item },
        unmappedRetained: {},
        hasLoss: false,
      };
    }

    const sourceFields = this.typesService.getOrderedFields(sourceType);
    const targetFields = this.typesService.getOrderedFields(targetType);
    const targetFieldKeys = new Set(
      targetFields.map((f: ItemFieldDefinition) => f.key),
    );
    const sourceLabelMap = new Map(
      sourceFields.map((f: ItemFieldDefinition) => [f.key, f.label]),
    );

    const preservedFields: string[] = [];
    const mappedFields: FieldMappingChange[] = [];
    const droppedFields: DroppedField[] = [];
    const unmappedRetained: Record<string, unknown> = {};

    const projectedItem: Record<string, unknown> = {
      ...item,
      itemType: targetType,
      type: targetType,
    };

    const sourceValues: Record<string, unknown> = {};
    for (const field of sourceFields) {
      const val = this.getItemFieldValue(item, field.key);
      if (val !== undefined && val !== null && val !== '') {
        sourceValues[field.key] = val;
      }
    }

    const persistentAcademicKeys = Array.from(
      new Set([
        ...ITEM_COLUMN_METADATA_FIELDS,
        ...Object.keys(FIELD_ALIASES),
        'title',
        'abstract',
        'abstractNote',
        'date',
        'year',
        'url',
        'extra',
        'citationKey',
      ]),
    );
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

    const newExtraFields: Record<string, unknown> = {
      ...((item.extraFields as Record<string, unknown> | undefined) || {}),
    };

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
      const matchedTargetKey = this.findMatchingTargetField(
        sField,
        targetFields,
      );
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
          const TYPE_SPECIFIC_COLUMN_KEYS = new Set([
            'isbn',
            'ISBN',
            'issn',
            'ISSN',
            'publicationTitle',
            'journal',
            'journalAbbr',
            'journalAbbreviation',
            'publisher',
            'place',
            'volume',
            'issue',
            'pages',
            'series',
            'seriesTitle',
            'seriesText',
            'seriesNumber',
            'edition',
            'section',
            'partNumber',
            'partTitle',
          ]);
          const isPersistentCol =
            (ITEM_COLUMN_METADATA_FIELDS.has(sField) ||
              ITEM_COLUMN_METADATA_FIELDS.has(FIELD_ALIASES[sField])) &&
            !TYPE_SPECIFIC_COLUMN_KEYS.has(sField);

          if (isPersistentCol) {
            projectedItem[sField] = val;
            const dbCol = FIELD_ALIASES[sField];
            if (dbCol) projectedItem[dbCol] = val;
            preservedFields.push(sField);
          } else {
            droppedFields.push({
              field: sField,
              label: String(sourceLabelMap.get(sField) || sField),
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

    if (options.retainUnmappedInExtra !== false && droppedFields.length > 0) {
      const extraLines: string[] = [];
      const currentExtra = projectedItem.extra || item.extra;
      if (
        currentExtra &&
        typeof currentExtra === 'string' &&
        currentExtra.trim()
      ) {
        extraLines.push(currentExtra.trim());
      }
      for (const dropped of droppedFields) {
        if (
          dropped.value !== undefined &&
          dropped.value !== null &&
          dropped.value !== ''
        ) {
          extraLines.push(
            `${dropped.label || dropped.field}: ${dropped.value}`,
          );
        }
      }
      if (extraLines.length > 0) {
        projectedItem.extra = extraLines.join('\n');
      }
    }

    const validCreatorRoles = new Set(
      this.typesService
        .getValidCreatorTypes(targetType)
        .map((c: CreatorTypeDefinition) => c.creatorType),
    );
    const targetPrimaryCreator =
      this.typesService.getPrimaryCreatorType(targetType);
    const creatorChanges: CreatorRoleChange[] = [];

    const projectedCreators = (
      (Array.isArray(item.creators) ? item.creators : []) as Array<
        Record<string, unknown>
      >
    ).map((c: Record<string, unknown>, index: number) => {
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
    });

    projectedItem.creators = projectedCreators;

    const hasLoss =
      droppedFields.length > 0 ||
      creatorChanges.some((c) => c.reason !== 'preserved');

    const sourceFieldKeySet = new Set(
      sourceFields.map((f: ItemFieldDefinition) => f.key),
    );
    const preservedOrMappedTargetKeySet = new Set([
      ...preservedFields,
      ...mappedFields.map((m) => m.toField),
    ]);
    const newAvailableFields = targetFields
      .map((f: ItemFieldDefinition) => f.key)
      .filter((tKey: string) => {
        if (sourceFieldKeySet.has(tKey)) return false;
        if (preservedOrMappedTargetKeySet.has(tKey)) return false;
        const val = this.getItemFieldValue(item, tKey);
        return val === undefined || val === null || val === '';
      });

    return {
      sourceType,
      targetType,
      preservedFields: Array.from(new Set(preservedFields)),
      mappedFields,
      droppedFields,
      newAvailableFields,
      creatorChanges,
      projectedItem,
      unmappedRetained,
      hasLoss,
    };
  }
}
