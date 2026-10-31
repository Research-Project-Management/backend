import { Injectable, BadRequestException } from '@nestjs/common';
import { TypesService } from '@/modules/library/catalog/services/types.service';
import { ItemsMapper } from './items.mapper';
import {
  TypeConversionPreview,
  FieldMappingChange,
  DroppedField,
  CreatorRoleChange,
} from '@/modules/library/core/types/bibliographic.types';
import {
  ITEM_COLUMN_METADATA_FIELDS,
  FIELD_ALIASES,
  REVERSE_FIELD_ALIASES,
} from '@/modules/library/catalog/types/items.constants';
import {
  ItemFieldDefinition,
  CreatorTypeDefinition,
} from '@/modules/library/core/types/schema.types';
import { applyStructuralTypeConversionRules } from './type-conversion-rules.domain';

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
    const candidateSuffixes = new Set<string>([
      lowerKey,
      ...(alias ? [alias.toLowerCase()] : []),
    ]);
    let unmappedVal: unknown;
    let unmappedSuffix: string | undefined;
    for (const container of [item.extraFields, item.metadata]) {
      if (
        !container ||
        typeof container !== 'object' ||
        Array.isArray(container)
      ) {
        continue;
      }
      for (const [k, v] of Object.entries(
        container as Record<string, unknown>,
      )) {
        if (v === undefined || v === null || v === '') continue;
        const m = k.match(/^__unmapped_[^_]+_(.+)$/i);
        if (m && m[1] && candidateSuffixes.has(m[1].toLowerCase())) {
          unmappedVal = v;
          unmappedSuffix = m[1];
          break;
        }
      }
      if (unmappedVal !== undefined) break;
    }

    if (typeof item.extra === 'string' && item.extra.trim()) {
      const targetNorms = new Set<string>();
      for (const s of candidateSuffixes) {
        targetNorms.add(s.replace(/[\s_-]+/g, ''));
      }
      if (unmappedSuffix) {
        targetNorms.add(unmappedSuffix.toLowerCase().replace(/[\s_-]+/g, ''));
      }
      for (const rawLine of item.extra.split(/\r?\n/)) {
        const kv = rawLine
          .trim()
          .match(/^([A-Za-z_][A-Za-z0-9._\s-]{0,40}?)\s*:\s*(.+)$/);
        if (!kv || !kv[1] || !kv[2]) continue;
        const kNorm = kv[1]
          .trim()
          .toLowerCase()
          .replace(/[\s_-]+/g, '');
        if (targetNorms.has(kNorm)) {
          return kv[2].trim();
        }
      }
    }

    if (unmappedVal !== undefined) {
      return unmappedVal;
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

    if (!this.typesService.isValidItemType(targetType)) {
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
        schemaUnsupportedFields: [],
        schemaUnsupportedFieldLabels: [],
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
    const targetLabelMap = new Map(
      targetFields.map((f: ItemFieldDefinition) => [f.key, f.label]),
    );

    const preservedFields: string[] = [];
    const mappedFields: FieldMappingChange[] = [];
    const droppedFields: DroppedField[] = [];
    const unmappedRetained: Record<string, unknown> = {};
    const recoveredExtraLineNorms = new Set<string>();

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

    const sourceBaseMap = this.typesService.getBaseFieldMapping(sourceType);
    const persistentAcademicKeys = Array.from(
      new Set([
        ...ITEM_COLUMN_METADATA_FIELDS,
        ...Object.keys(FIELD_ALIASES),
        ...targetFields.map((f: ItemFieldDefinition) => f.key),
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
      if (k === 'itemType' || k === 'type') continue;
      const val = this.getItemFieldValue(item, k);
      if (val !== undefined && val !== null && val !== '') {
        const canonicalKey = FIELD_ALIASES[k]
          ? k
          : REVERSE_FIELD_ALIASES[k] || k;
        const baseKey = FIELD_ALIASES[k] || k;
        const mappedSourceField =
          sourceBaseMap[k] ||
          sourceBaseMap[baseKey] ||
          sourceBaseMap[canonicalKey] ||
          (baseKey === 'issue' ? sourceBaseMap.number : undefined);
        if (
          mappedSourceField &&
          mappedSourceField !== canonicalKey &&
          sourceValues[mappedSourceField] !== undefined
        ) {
          continue;
        }
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
    delete newExtraFields.itemType;
    delete newExtraFields.type;

    applyStructuralTypeConversionRules(sourceType, targetType, {
      sourceValues,
      projectedItem,
      mappedFields,
      droppedFields,
      unmappedRetained,
      newExtraFields,
      retainUnmappedInExtra: options.retainUnmappedInExtra !== false,
    });
    if (projectedItem.shortTitle === undefined) {
      delete newExtraFields.shortTitle;
    }

    const removeRecoveredUnmappedField = (keys: string[]) => {
      const lowerSet = new Set<string>();
      for (const k of keys) {
        if (!k) continue;
        lowerSet.add(k.toLowerCase());
        recoveredExtraLineNorms.add(k.toLowerCase().replace(/[\s_-]+/g, ''));
        const lbl = targetLabelMap.get(k) || sourceLabelMap.get(k);
        if (lbl)
          recoveredExtraLineNorms.add(
            String(lbl)
              .toLowerCase()
              .replace(/[\s_-]+/g, ''),
          );
        const alias = FIELD_ALIASES[k] || REVERSE_FIELD_ALIASES[k];
        if (alias) {
          lowerSet.add(alias.toLowerCase());
          recoveredExtraLineNorms.add(
            alias.toLowerCase().replace(/[\s_-]+/g, ''),
          );
          const aliasLbl =
            targetLabelMap.get(alias) || sourceLabelMap.get(alias);
          if (aliasLbl)
            recoveredExtraLineNorms.add(
              String(aliasLbl)
                .toLowerCase()
                .replace(/[\s_-]+/g, ''),
            );
        }
      }
      for (const efKey of Object.keys(newExtraFields)) {
        const m = efKey.match(/^__unmapped_[^_]+_(.+)$/i);
        if (m && m[1] && lowerSet.has(m[1].toLowerCase())) {
          delete newExtraFields[efKey];
          const suffix = m[1];
          recoveredExtraLineNorms.add(
            suffix.toLowerCase().replace(/[\s_-]+/g, ''),
          );
          const lbl =
            targetLabelMap.get(suffix) ||
            sourceLabelMap.get(suffix) ||
            keys
              .map((k) => targetLabelMap.get(k) || sourceLabelMap.get(k))
              .find(Boolean);
          if (lbl) {
            recoveredExtraLineNorms.add(
              String(lbl)
                .toLowerCase()
                .replace(/[\s_-]+/g, ''),
            );
          }
        }
      }
    };

    for (const mapped of mappedFields) {
      removeRecoveredUnmappedField([mapped.fromField, mapped.toField]);
    }
    for (const tField of targetFields) {
      removeRecoveredUnmappedField([tField.key]);
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
        removeRecoveredUnmappedField([sField, matchedTargetKey]);
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
          delete projectedItem[sField];
          delete newExtraFields[sField];
          removeRecoveredUnmappedField([sField, resolved.targetField]);
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
            delete projectedItem[sField];
            delete newExtraFields[sField];
            const aliasKey =
              FIELD_ALIASES[sField] || REVERSE_FIELD_ALIASES[sField];
            if (aliasKey) {
              delete projectedItem[aliasKey];
              delete newExtraFields[aliasKey];
            }
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

    if (
      projectedItem.metadata &&
      typeof projectedItem.metadata === 'object' &&
      !Array.isArray(projectedItem.metadata)
    ) {
      const cleanedMeta: Record<string, unknown> = {
        ...(projectedItem.metadata as Record<string, unknown>),
      };
      for (const dropped of droppedFields) {
        delete cleanedMeta[dropped.field];
        const aliasKey =
          FIELD_ALIASES[dropped.field] || REVERSE_FIELD_ALIASES[dropped.field];
        if (aliasKey) delete cleanedMeta[aliasKey];
      }
      for (const mapped of mappedFields) {
        if (mapped.fromField !== mapped.toField) {
          delete cleanedMeta[mapped.fromField];
          const aliasKey =
            FIELD_ALIASES[mapped.fromField] ||
            REVERSE_FIELD_ALIASES[mapped.fromField];
          if (aliasKey && aliasKey !== mapped.toField) {
            delete cleanedMeta[aliasKey];
          }
        }
      }
      for (const mk of Object.keys(cleanedMeta)) {
        const m = mk.match(/^__unmapped_[^_]+_(.+)$/i);
        if (
          m &&
          m[1] &&
          recoveredExtraLineNorms.has(
            m[1].toLowerCase().replace(/[\s_-]+/g, ''),
          )
        ) {
          delete cleanedMeta[mk];
        }
      }
      projectedItem.metadata = cleanedMeta;
    }

    projectedItem.extraFields = newExtraFields;

    if (
      recoveredExtraLineNorms.size > 0 &&
      typeof projectedItem.extra === 'string' &&
      projectedItem.extra.trim()
    ) {
      const filteredLines = projectedItem.extra
        .split(/\r?\n/)
        .filter((line) => {
          const kv = line
            .trim()
            .match(/^([A-Za-z_][A-Za-z0-9._\s-]{0,40}?)\s*:\s*(.+)$/);
          if (!kv || !kv[1]) return true;
          const kNorm = kv[1]
            .trim()
            .toLowerCase()
            .replace(/[\s_-]+/g, '');
          return !recoveredExtraLineNorms.has(kNorm);
        });
      projectedItem.extra = filteredLines.join('\n').trim();
    }

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
      const existingLineSet = new Set(
        extraLines
          .flatMap((block) => block.split(/\r?\n/))
          .map((l) => l.trim().toLowerCase())
          .filter(Boolean),
      );
      for (const dropped of droppedFields) {
        if (
          (typeof dropped.value === 'string' && dropped.value !== '') ||
          typeof dropped.value === 'number' ||
          typeof dropped.value === 'boolean'
        ) {
          const candidateLine = `${dropped.label || dropped.field}: ${String(dropped.value)}`;
          const candidateLower = candidateLine.trim().toLowerCase();
          if (!existingLineSet.has(candidateLower)) {
            existingLineSet.add(candidateLower);
            extraLines.push(candidateLine);
          }
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
    const sourcePrimaryCreator =
      this.typesService.getPrimaryCreatorType(sourceType);
    const targetPrimaryCreator =
      this.typesService.getPrimaryCreatorType(targetType);
    const allPrimaryCreatorRoles = new Set([
      'author',
      'director',
      'interviewer',
      'podcaster',
      'inventor',
      'programmer',
      'artist',
      'cartographer',
      'composer',
      'performer',
      'presenter',
      'sponsor',
      sourcePrimaryCreator,
    ]);
    const creatorChanges: CreatorRoleChange[] = [];

    const rawSourceCreators = (
      Array.isArray(item.creators) && item.creators.length > 0
        ? item.creators
        : Array.isArray(item.contributors)
          ? item.contributors
          : []
    ) as Array<Record<string, unknown>>;

    const projectedCreators = rawSourceCreators.map(
      (c: Record<string, unknown>, index: number) => {
        const fromRole =
          (c.creatorType as string) || (c.role as string) || 'author';
        let toRole: string = fromRole;
        let reason: 'preserved' | 'primary-fallback' | 'secondary-fallback' =
          'preserved';

        if (!validCreatorRoles.has(fromRole)) {
          if (
            (allPrimaryCreatorRoles.has(fromRole) || index === 0) &&
            validCreatorRoles.has(targetPrimaryCreator)
          ) {
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
        return { ...c, creatorType: toRole, role: toRole };
      },
    );

    projectedItem.itemType = targetType;
    projectedItem.type = targetType;
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

    const alwaysPreservedCoreFields = new Set([
      'title',
      'abstract',
      'abstractNote',
      'date',
      'year',
      'url',
      'doi',
      'DOI',
      'extra',
      'citationKey',
    ]);
    const schemaUnsupportedFieldDefs = sourceFields.filter(
      (sf: ItemFieldDefinition) => {
        if (alwaysPreservedCoreFields.has(sf.key)) return false;
        if (this.findMatchingTargetField(sf.key, targetFields)) return false;
        const resolved = this.typesService.resolveBaseFieldMapping(
          sourceType,
          targetType,
          sf.key,
        );
        if (
          resolved?.targetField &&
          targetFieldKeys.has(resolved.targetField)
        ) {
          return false;
        }
        return true;
      },
    );
    const schemaUnsupportedFields = schemaUnsupportedFieldDefs.map(
      (sf: ItemFieldDefinition) => sf.key,
    );
    const schemaUnsupportedFieldLabels = schemaUnsupportedFieldDefs.map(
      (sf: ItemFieldDefinition) => String(sf.label || sf.key),
    );

    return {
      sourceType,
      targetType,
      preservedFields: Array.from(new Set(preservedFields)),
      mappedFields,
      droppedFields,
      newAvailableFields,
      schemaUnsupportedFields,
      schemaUnsupportedFieldLabels,
      creatorChanges,
      projectedItem,
      unmappedRetained,
      hasLoss,
    };
  }
}
