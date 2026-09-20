import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { QueryRepository } from '../../../infrastructure/repositories/query.repository';
import { CommandRepository } from '../../../infrastructure/repositories/command.repository';
import { TypesService } from '../../services/types.service';
import { ItemsMapper } from '../../../infrastructure/mappers/items.mapper';
import { ItemTransformer } from '../../../infrastructure/mappers/item.transformer';
import {
  TypeConversionPreview,
  ConvertTypeOptions,
} from '../../../domain/types/items.types';
import { ItemDetail } from '../../../domain/ports/items.ports';
import {
  ITEM_COLUMN_METADATA_FIELDS,
  FIELD_ALIASES,
} from '../../../domain/constants/items.constants';

export interface ConvertItemTypeCommand {
  userId: string;
  itemId: string;
  targetType: string;
  options?: ConvertTypeOptions;
}

export interface ConvertItemTypeResult {
  success: boolean;
  item: any;
  conversionReport: TypeConversionPreview;
}

/**
 * Command Use Case — Convert Item Type
 *
 * Executes a type conversion (e.g., journalArticle → bookSection) transactionally.
 * Generates a conversion preview, maps fields to the target schema, and persists
 * the updated item. Returns both the updated item and the conversion report.
 *
 * Extracted from ItemsService.convertItemType().
 * Application layer: no Prisma, no NestJS HTTP.
 */
@Injectable()
export class ConvertItemTypeUseCase {
  private readonly logger = new Logger(ConvertItemTypeUseCase.name);

  constructor(
    private readonly queryRepo: QueryRepository,
    private readonly commandRepo: CommandRepository,
    private readonly typesService: TypesService,
    private readonly transformer: ItemTransformer,
  ) {}

  async execute(
    command: ConvertItemTypeCommand,
  ): Promise<ConvertItemTypeResult> {
    const rawExisting = await this.queryRepo.findById(
      command.userId,
      command.itemId,
    );
    if (!rawExisting) {
      throw new NotFoundException(
        `Item ${command.itemId} not found in user library`,
      );
    }

    const existing = ItemsMapper.toDomain<ItemDetail>(rawExisting);

    const preview = this.transformer.previewConversion(
      existing,
      command.targetType,
      { retainUnmappedInExtra: command.options?.retainUnmappedInExtra ?? true },
    );

    const projected = preview.projectedItem;
    const targetFields = this.typesService.getOrderedFields(command.targetType);

    const dynamicExtraFields: Record<string, any> = {
      ...(projected.extraFields || {}),
    };

    for (const field of targetFields) {
      const val = this.transformer.getItemFieldValue(projected, field.key);
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
      itemType: command.targetType,
      type: command.targetType,
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
          this.transformer.getItemFieldValue(projected, col) ??
          (existing as unknown as Record<string, unknown>)[col];
        if (val !== undefined) {
          updatePayload[col] = val;
        }
      }
    }

    const updated = await this.commandRepo.update(
      command.userId,
      command.itemId,
      command.options?.expectedVersion,
      updatePayload,
    );

    return {
      success: true,
      item: ItemsMapper.toDomain(updated),
      conversionReport: preview,
    };
  }
}
