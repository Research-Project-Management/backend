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
} from '@/modules/library/catalog/types/items.constants';
import {
  normalizeProjectScopeId,
  LIBRARY_EVENT_TYPES,
  TransactionHelpers,
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

    const updated =
      !tx && this.libraryTx
        ? await this.libraryTx.executeInTransaction(
            async (
              innerTx: Prisma.TransactionClient,
              helpers: TransactionHelpers,
            ) => {
              const res = await this.command.update(
                userId,
                itemId,
                options.expectedVersion,
                updatePayload,
                innerTx,
                projectId,
              );
              const eventScope = {
                userId,
                projectId: effectiveProjectId,
              };
              await helpers.appendChange(eventScope, {
                entityType: 'Item',
                entityId: itemId,
                action: 'update',
                version: res.version,
                data: res,
              });
              await helpers.publishOutbox(
                eventScope,
                itemId,
                LIBRARY_EVENT_TYPES.ITEM_UPDATED,
                res,
              );
              return res;
            },
          )
        : await this.command.update(
            userId,
            itemId,
            options.expectedVersion,
            updatePayload,
            tx,
            projectId,
          );

    if (!tx) {
      await this.cacheCoordinator?.invalidateItemCache(
        itemId,
        userId,
        effectiveProjectId,
      );
    }

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

  const updatePayload: Record<string, unknown> = {
    itemType: targetType,
    type: targetType,
    creators: projected.creators ?? existing.creators,
    extraFields: dynamicExtraFields,
  };

  const droppedSet = new Set(
    preview.droppedFields.map((d) => d.field.toLowerCase()),
  );

  for (const col of ITEM_COLUMN_METADATA_FIELDS) {
    if (FIELD_ALIASES[col] && FIELD_ALIASES[col] !== col) continue;

    const colLower = col.toLowerCase();
    if (droppedSet.has(colLower)) {
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
