import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { QueryRepository } from '../repositories/query.repository';
import { CommandRepository } from '../repositories/command.repository';
import { TypesService } from './types.service';
import { ItemTransformer } from '../utils/item.transformer';
import { ItemsMapper } from '../utils/items.mapper';
import {
  ItemDetail,
  TypeConversionPreview,
  ConvertTypeOptions,
} from '../types/items.types';
import {
  ITEM_COLUMN_METADATA_FIELDS,
  FIELD_ALIASES,
} from '../types/items.constants';

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
  ) {}

  /**
   * Generates a deterministic preview of item-type conversion without modifying DB state.
   */
  previewTypeConversion(
    rawItem: Record<string, any>,
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
    tx?: Prisma.TransactionClient,
  ) {
    const rawExisting = await this.query.findById(
      userId,
      itemId,
      undefined,
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

    const updated = await this.command.update(
      userId,
      itemId,
      options.expectedVersion,
      updatePayload,
      tx,
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
  existing: any,
  preview: TypeConversionPreview,
  targetFields: any[],
  transformer: ItemTransformer,
): Record<string, any> {
  const projected = preview.projectedItem;
  const dynamicExtraFields: Record<string, any> = {
    ...(projected.extraFields || {}),
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

  const updatePayload: Record<string, any> = {
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
