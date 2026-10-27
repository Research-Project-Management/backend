import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import { TypesService } from './types.service';
import { ItemCacheCoordinator } from './item-cache.coordinator';
import { ItemTransformer } from '@/modules/library/catalog/domain/item.transformer';
import { ItemsMapper } from '@/modules/library/catalog/domain/items.mapper';
import {
  ItemDetail,
  TypeConversionPreview,
  ConvertTypeOptions,
} from '@/modules/library/core/types/bibliographic.types';
import {
  ITEM_COLUMN_METADATA_FIELDS,
  FIELD_ALIASES,
  REVERSE_FIELD_ALIASES,
} from '@/modules/library/catalog/types/items.constants';
import {
  normalizeProjectScopeId,
  LIBRARY_EVENT_TYPES,
  TransactionHelpers,
  ItemProvenancePolicy,
} from '@/modules/library/core';
import { TransactionService } from '@/modules/library/sync';

import { ItemFieldDefinition } from '@/modules/library/core/types/schema.types';

/**
 * ItemTypeConversionService — Dedicated Domain Service for Item Type conversions.
 * Encapsulates deterministic conversion preview, CSL field preservation,
 * dynamic extra-field projection, and database transactional updates.
 */
@Injectable()
export class ItemTypeConversionService {
  constructor(
    private readonly query: QueryRepository,
    private readonly command: CommandRepository,
    private readonly typesService: TypesService,
    private readonly transformer: ItemTransformer,
    @Optional() private readonly libraryTx?: TransactionService,
    @Optional() private readonly cacheCoordinator?: ItemCacheCoordinator,
  ) {}

  /**
   * Generates a deterministic preview of item-type conversion without modifying DB state.
   */
  previewTypeConversion(
    rawItem: Record<string, unknown>,
    targetType: string,
    options: { retainUnmappedInExtra?: boolean } = {},
  ): TypeConversionPreview {
    return this.transformer.previewConversion(rawItem, targetType, options);
  }

  /**
   * Executes type conversion transactionally in the database.
   */
  async convertItemType(
    userId: string,
    itemId: string,
    targetType: string,
    options: ConvertTypeOptions = {},
    projectId?: string,
    tx?: Prisma.TransactionClient,
    helpers?: TransactionHelpers,
  ) {
    const rawExisting = await this.query.findById(
      userId,
      itemId,
      projectId,
      tx,
    );
    if (!rawExisting) {
      throw new NotFoundException(`Item ${itemId} not found in user library`);
    }
    const existing = ItemsMapper.toDomain<ItemDetail>(rawExisting);
    if (rawExisting.itemType === 'preprint' && rawExisting.publicationTitle == null) {
      const rawMeta =
        rawExisting.metadata &&
        typeof rawExisting.metadata === 'object' &&
        !Array.isArray(rawExisting.metadata)
          ? (rawExisting.metadata as Record<string, unknown>)
          : {};
      if (rawMeta.publicationTitle == null) {
        delete (existing as unknown as Record<string, unknown>).publicationTitle;
      }
      if (rawMeta.publisher == null) {
        delete (existing as unknown as Record<string, unknown>).publisher;
      }
    }

    const preview = this.previewTypeConversion(existing, targetType, {
      retainUnmappedInExtra: options.retainUnmappedInExtra ?? true,
    });

    const targetFields = this.typesService.getOrderedFields(targetType);
    const updatePayload = buildTypeConversionUpdatePayload(
      targetType,
      existing,
      preview,
      targetFields,
      this.transformer,
    );

    const effectiveProjectId =
      normalizeProjectScopeId(projectId ?? existing.projectId) ?? undefined;
    const eventScope = {
      userId,
      projectId: effectiveProjectId,
    };

    const recordConversionEvents = async (
      res: { version: number; [key: string]: unknown },
      activeHelpers?: TransactionHelpers,
    ) => {
      if (!activeHelpers) return;
      const domainRes = ItemsMapper.toDomain(res);
      await activeHelpers.appendChange(eventScope, {
        entityType: 'Item',
        entityId: itemId,
        action: 'update',
        version: res.version,
        data: domainRes,
      });
      await activeHelpers.publishOutbox(
        eventScope,
        itemId,
        LIBRARY_EVENT_TYPES.ITEM_UPDATED,
        domainRes,
      );
    };

    const updated =
      !tx && this.libraryTx
        ? await this.libraryTx.executeInTransaction(
            async (
              innerTx: Prisma.TransactionClient,
              innerHelpers: TransactionHelpers,
            ) => {
              const res = await this.command.update(
                userId,
                itemId,
                options.expectedVersion,
                updatePayload,
                innerTx,
                projectId,
              );
              await recordConversionEvents(res, innerHelpers);
              return res;
            },
          )
        : await (async () => {
            const res = await this.command.update(
              userId,
              itemId,
              options.expectedVersion,
              updatePayload,
              tx,
              projectId,
            );
            await recordConversionEvents(res, helpers);
            return res;
          })();

    await this.cacheCoordinator?.invalidateItemCache(
      itemId,
      userId,
      effectiveProjectId,
    );

    return {
      success: true,
      item: ItemsMapper.toDomain(updated),
      conversionReport: preview,
    };
  }
}

export function buildTypeConversionUpdatePayload(
  targetType: string,
  existing: ItemDetail,
  preview: TypeConversionPreview,
  targetFields: ItemFieldDefinition[],
  transformer: ItemTransformer,
): Record<string, unknown> {
  const projected = preview.projectedItem;
  const dynamicExtraFields: Record<string, unknown> = {
    ...((projected.extraFields as Record<string, unknown> | undefined) || {}),
  };
  delete dynamicExtraFields.itemType;
  delete dynamicExtraFields.type;

  const droppedSet = new Set(
    preview.droppedFields.map((d) => d.field.toLowerCase()),
  );
  const mappedOutSet = new Set(
    preview.mappedFields
      .filter((m) => m.fromField.toLowerCase() !== m.toField.toLowerCase())
      .map((m) => m.fromField.toLowerCase()),
  );

  for (const dropped of preview.droppedFields) {
    delete dynamicExtraFields[dropped.field];
    const aliasKey =
      FIELD_ALIASES[dropped.field] || REVERSE_FIELD_ALIASES[dropped.field];
    if (aliasKey) delete dynamicExtraFields[aliasKey];
  }
  for (const mapped of preview.mappedFields) {
    if (mapped.fromField !== mapped.toField) {
      delete dynamicExtraFields[mapped.fromField];
      const aliasKey =
        FIELD_ALIASES[mapped.fromField] ||
        REVERSE_FIELD_ALIASES[mapped.fromField];
      if (aliasKey && aliasKey !== mapped.toField) {
        delete dynamicExtraFields[aliasKey];
      }
    }
  }

  for (const field of targetFields) {
    const val = transformer.getItemFieldValue(projected, field.key);
    if (
      val !== undefined &&
      val !== null &&
      val !== '' &&
      !ITEM_COLUMN_METADATA_FIELDS.has(field.key) &&
      !ITEM_COLUMN_METADATA_FIELDS.has(FIELD_ALIASES[field.key])
    ) {
      dynamicExtraFields[field.key] = val;
    }
  }

  const metadataPatch: Record<string, unknown> = {};
  for (const dropped of preview.droppedFields) {
    metadataPatch[dropped.field] = null;
    const aliasKey =
      FIELD_ALIASES[dropped.field] || REVERSE_FIELD_ALIASES[dropped.field];
    if (aliasKey) metadataPatch[aliasKey] = null;
  }
  for (const mapped of preview.mappedFields) {
    if (mapped.fromField !== mapped.toField) {
      metadataPatch[mapped.fromField] = null;
      const aliasKey =
        FIELD_ALIASES[mapped.fromField] ||
        REVERSE_FIELD_ALIASES[mapped.fromField];
      if (aliasKey && aliasKey !== mapped.toField) {
        metadataPatch[aliasKey] = null;
      }
    }
  }

  const { fieldProvenance, lockedFields } =
    ItemProvenancePolicy.transferConversionProvenance(existing, preview);

  metadataPatch.fieldProvenance = fieldProvenance;
  metadataPatch.lockedFields = lockedFields;

  const updatePayload: Record<string, unknown> = {
    __isSystemUpdate: true,
    itemType: targetType,
    type: targetType,
    creators: projected.creators ?? existing.creators,
    contributors: projected.creators ?? existing.contributors ?? existing.creators,
    extraFields: dynamicExtraFields,
    ...(projected.extra !== undefined ? { extra: projected.extra } : {}),
    metadata: metadataPatch,
  };

  for (const col of ITEM_COLUMN_METADATA_FIELDS) {
    if (FIELD_ALIASES[col] && FIELD_ALIASES[col] !== col) continue;

    const colLower = col.toLowerCase();
    if (droppedSet.has(colLower) || mappedOutSet.has(colLower)) {
      updatePayload[col] = null;
    } else {
      const val =
        transformer.getItemFieldValue(projected, col) ??
        (existing as unknown as Record<string, unknown>)[col];
      if (val !== undefined) {
        updatePayload[col] = val;
      }
    }
  }

  return updatePayload;
}
