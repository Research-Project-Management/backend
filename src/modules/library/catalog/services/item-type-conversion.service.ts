import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ItemTypeRegistryService } from '../registry/item-type-registry.service';
import { CatalogRepository } from '../catalog.repository';
import { CatalogItemMapper } from '../mappers/catalog-item.mapper';
import { Prisma } from '@prisma/client';

export interface FieldMappingChange {
  fromField: string;
  toField: string;
  value: unknown;
  rule: 'direct' | 'base-semantic' | 'special-rule';
}

export interface DroppedField {
  field: string;
  /** Human-readable label from the registry (e.g. "Publication Title") */
  label: string;
  value: unknown;
}

export interface CreatorRoleChange {
  creator: Record<string, unknown>;
  fromRole: string;
  toRole: string;
  reason: 'preserved' | 'primary-fallback' | 'secondary-fallback';
}

export interface TypeConversionPreview {
  sourceType: string;
  targetType: string;
  preservedFields: string[];
  mappedFields: FieldMappingChange[];
  droppedFields: DroppedField[];
  creatorChanges: CreatorRoleChange[];
  projectedItem: Record<string, any>;
  unmappedRetained: Record<string, any>;
  /**
   * true when any field with a non-empty value will no longer appear in the
   * target type's standard schema (values are retained in extraFields.__unmapped_*
   * but the user should be warned and must confirm).
   */
  hasLoss: boolean;
}

export interface ConvertTypeOptions {
  expectedVersion?: number;
  retainUnmappedInExtra?: boolean;
}

// DB column names persisted directly as top-level scalar columns on CatalogItem.
// All other type-specific fields live in extraFields (jsonb).
const DB_SCALAR_COLUMNS = new Set([
  'title',
  'abstract',
  'abstractNote',
  'date',
  'year',
  'url',
  'doi',
  'isbn',
  'issn',
  'language',
  'shortTitle',
  'rights',
  'extra',
  'citationKey',
  'publicationTitle',
  'publisher',
  'volume',
  'issue',
  'pages',
  'series',
  'seriesTitle',
]);

@Injectable()
export class ItemTypeConversionService {
  private readonly logger = new Logger(ItemTypeConversionService.name);

  constructor(
    private readonly registryService: ItemTypeRegistryService,
    private readonly repository: CatalogRepository,
  ) {}

  /**
   * Generates a deterministic preview of item-type conversion without modifying DB state.
   */
  previewConversion(
    rawItem: Record<string, any>,
    targetType: string,
    options: { retainUnmappedInExtra?: boolean } = {},
  ): TypeConversionPreview {
    const item = CatalogItemMapper.toDomain(rawItem);
    const sourceType = item.itemType || item.type || 'journalArticle';

    if (!this.registryService.isValidType(targetType)) {
      throw new BadRequestException(`Invalid target itemType: ${targetType}`);
    }

    if (!this.registryService.isBibliographic(sourceType)) {
      throw new BadRequestException(
        `Cannot convert non-bibliographic item type: ${sourceType}`,
      );
    }

    if (!this.registryService.isBibliographic(targetType)) {
      throw new BadRequestException(
        `Cannot convert to special non-bibliographic item type: ${targetType}`,
      );
    }

    if (sourceType === targetType) {
      return {
        sourceType,
        targetType,
        preservedFields: this.registryService
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

    const sourceFields = this.registryService.getOrderedFields(sourceType);
    const targetFields = this.registryService.getOrderedFields(targetType);
    const targetFieldKeys = new Set(targetFields.map((f) => f.key));

    // Build label lookup from source fields
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

    // Extract all source field values (schema fields + common identifiers)
    const sourceValues: Record<string, any> = {};
    for (const field of sourceFields) {
      const val = item[field.key] ?? item.extraFields?.[field.key];
      if (val !== undefined && val !== null && val !== '') {
        sourceValues[field.key] = val;
      }
    }

    const commonKeys = [
      'title',
      'abstract',
      'abstractNote',
      'date',
      'year',
      'url',
      'doi',
      'isbn',
      'issn',
      'language',
      'shortTitle',
      'rights',
      'extra',
    ];
    for (const k of commonKeys) {
      if (
        item[k] !== undefined &&
        item[k] !== null &&
        item[k] !== '' &&
        sourceValues[k] === undefined
      ) {
        sourceValues[k] = item[k];
      }
    }

    // Remove source-specific fields from projectedItem that don't exist in target
    for (const field of sourceFields) {
      if (
        !targetFieldKeys.has(field.key) &&
        field.key !== 'title' &&
        field.key !== 'abstract' &&
        field.key !== 'abstractNote' &&
        field.key !== 'url' &&
        field.key !== 'doi'
      ) {
        delete projectedItem[field.key];
      }
    }

    const newExtraFields: Record<string, any> = { ...(item.extraFields || {}) };

    // Special Case: book <-> bookSection
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
        projectedItem.title = sourceValues.bookTitle;
        mappedFields.push({
          fromField: 'bookTitle',
          toField: 'title',
          value: sourceValues.bookTitle,
          rule: 'special-rule',
        });
        delete sourceValues.bookTitle;
      }
      delete projectedItem.shortTitle;
      delete sourceValues.shortTitle;
    }

    // Process all source fields through target schema
    for (const [sField, val] of Object.entries(sourceValues)) {
      if (targetFieldKeys.has(sField)) {
        projectedItem[sField] = val;
        preservedFields.push(sField);
      } else {
        const resolved = this.registryService.resolveBaseFieldMapping(
          sourceType,
          targetType,
          sField,
        );

        if (
          resolved?.targetField &&
          targetFieldKeys.has(resolved.targetField)
        ) {
          projectedItem[resolved.targetField] = val;
          mappedFields.push({
            fromField: sField,
            toField: resolved.targetField,
            value: val,
            rule: 'base-semantic',
          });
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

    projectedItem.extraFields = newExtraFields;

    // Process Creators — map invalid roles to target primary or contributor
    const validCreatorRoles = new Set(
      this.registryService
        .getValidCreatorTypes(targetType)
        .map((c) => c.creatorType),
    );
    const targetPrimaryCreator =
      this.registryService.getPrimaryCreatorType(targetType);
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
      preservedFields,
      mappedFields,
      droppedFields,
      creatorChanges,
      projectedItem,
      unmappedRetained,
      hasLoss,
    };
  }

  /**
   * Executes type conversion transactionally in the database.
   * Uses a fully dynamic payload from projectedItem — no field is silently dropped.
   */
  async convertItemType(
    workspaceId: string,
    itemId: string,
    targetType: string,
    options: ConvertTypeOptions = {},
    tx?: Prisma.TransactionClient,
  ) {
    const existing = await this.repository.findById(workspaceId, itemId, tx);
    if (!existing) {
      throw new NotFoundException(
        `Item ${itemId} not found in workspace ${workspaceId}`,
      );
    }

    const preview = this.previewConversion(existing, targetType, {
      retainUnmappedInExtra: options.retainUnmappedInExtra ?? true,
    });

    const projected = preview.projectedItem;

    // Build dynamic extra fields: target-specific fields that aren't DB scalar columns
    const targetFields = this.registryService.getOrderedFields(targetType);
    const dynamicExtraFields: Record<string, any> = {
      ...(projected.extraFields || {}),
    };

    for (const field of targetFields) {
      const val = projected[field.key];
      if (
        val !== undefined &&
        val !== null &&
        val !== '' &&
        !DB_SCALAR_COLUMNS.has(field.key)
      ) {
        dynamicExtraFields[field.key] = val;
      }
    }

    // Build top-level payload with all DB scalar columns
    const updatePayload: Record<string, any> = {
      itemType: targetType,
      type: targetType,
      creators: projected.creators ?? (existing as any).creators,
      extraFields: dynamicExtraFields,
    };

    for (const col of DB_SCALAR_COLUMNS) {
      const val = projected[col] ?? existing[col as keyof typeof existing];
      if (val !== undefined) {
        updatePayload[col] = val;
      }
    }

    const updated = await this.repository.update(
      workspaceId,
      itemId,
      options.expectedVersion,
      updatePayload,
      tx,
    );

    return {
      success: true,
      item: CatalogItemMapper.toDomain(updated),
      conversionReport: preview,
    };
  }
}
