import { Injectable, BadRequestException } from '@nestjs/common';
import { TypesService } from '@/modules/library/catalog/services/schema-validator.service';
import { ItemsMapper } from '@/modules/library/core';
import { TypeConversionPreview } from '@/modules/library/core/types/bibliographic.types';
import { ItemFieldDefinition } from '@/modules/library/core/types/schema.types';
import {
  getItemFieldValueWithTombstones,
  findMatchingTargetFieldInSchema,
  previewItemTypeConversion,
} from '../domain/type-conversion.policy';

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
 * Delegates pure Zotero schema field lookups, Base Field remapping, and Unmapped Field
 * Tombstones (`__unmapped_*` preservation and restoration) to `type-conversion.policy.ts`.
 */
@Injectable()
export class ItemTransformer implements IItemTransformerPort {
  constructor(private readonly typesService: TypesService) {}

  /**
   * Retrieves an item's field value taking into account direct properties,
   * `extraFields`, field aliases, `__unmapped_*` tombstones, and Zotero `Extra` lines.
   */
  getItemFieldValue(item: Record<string, unknown>, key: string): unknown {
    return getItemFieldValueWithTombstones(item, key);
  }

  /**
   * Finds the matching target field key in a target item type's field definitions.
   */
  findMatchingTargetField(
    sourceKey: string,
    targetFields: ItemFieldDefinition[],
  ): string | undefined {
    return findMatchingTargetFieldInSchema(sourceKey, targetFields);
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
    const sourceType = (item.itemType || item.type || 'journalArticle') as string;

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

    return previewItemTypeConversion(item, targetType, options, this.typesService);
  }
}
