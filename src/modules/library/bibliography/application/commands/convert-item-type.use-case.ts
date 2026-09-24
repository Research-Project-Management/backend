import { Injectable, Inject, NotFoundException, Logger } from '@nestjs/common';
import {
  ITEM_REPOSITORY_PORT,
  IItemRepositoryPort,
} from '../../domain/ports/item-repository.port';
import { TypesService } from '../services/types.service';
import {
  ITEM_TRANSFORMER_PORT,
  IItemTransformerPort,
} from '../../domain/ports/item-transformer.port';
import {
  TypeConversionPreview,
  ConvertTypeOptions,
} from '../../domain/types/items.types';
import { toItemResultDto } from '../dtos/item-result.dto';

export interface ConvertItemTypeCommand {
  userId: string;
  itemId: string;
  targetType: string;
  options?: ConvertTypeOptions;
  projectId?: string;
}

export interface ConvertItemTypeResult {
  success: boolean;
  item: any;
  conversionReport: TypeConversionPreview;
}

/**
 * Command Use Case — Convert Item Type
 *
 * Clean Architecture & DDD:
 * Operates on ItemAggregate and persists via IItemRepositoryPort with
 * optimistic concurrency versioning. Zero raw SQL or concrete repository coupling.
 */
@Injectable()
export class ConvertItemTypeUseCase {
  private readonly logger = new Logger(ConvertItemTypeUseCase.name);

  constructor(
    @Inject(ITEM_REPOSITORY_PORT)
    private readonly itemRepo: IItemRepositoryPort,
    private readonly typesService: TypesService,
    @Inject(ITEM_TRANSFORMER_PORT)
    private readonly transformer: IItemTransformerPort,
  ) {}

  async execute(
    command: ConvertItemTypeCommand,
  ): Promise<ConvertItemTypeResult> {
    const aggregate = await this.itemRepo.findById(
      command.userId,
      command.itemId,
      command.projectId,
    );
    if (!aggregate) {
      throw new NotFoundException(
        `Item ${command.itemId} not found in library`,
      );
    }

    const existingData: Record<string, any> = {
      id: aggregate.id,
      title: aggregate.title,
      itemType: aggregate.itemType,
      doi: aggregate.doi,
      citationKey: aggregate.citationKey,
      abstract: aggregate.abstract,
      year: aggregate.year,
      publicationTitle: aggregate.publicationTitle,
      ...aggregate.fields,
    };

    const preview = this.transformer.previewConversion(
      existingData,
      command.targetType,
      { retainUnmappedInExtra: command.options?.retainUnmappedInExtra ?? true },
    );

    const projected = preview.projectedItem as Record<string, any>;
    const targetFields = this.typesService.getOrderedFields(command.targetType);

    const dynamicExtraFields: Record<string, any> = {
      ...(aggregate.fields ?? {}),
      ...(projected.extraFields || {}),
    };

    for (const field of targetFields) {
      const val = this.transformer.getItemFieldValue(projected, field.key);
      if (val !== undefined && val !== null && val !== '') {
        dynamicExtraFields[field.key] = val;
      }
    }

    aggregate.updateMetadata(
      {
        itemType: command.targetType,
        title: (projected.title as string) ?? aggregate.title,
        publicationTitle:
          (projected.publicationTitle as string | undefined) ??
          aggregate.publicationTitle,
        year: (projected.year as number | undefined) ?? aggregate.year,
        doi: (projected.doi as string | undefined) ?? aggregate.doi,
        citationKey:
          (projected.citationKey as string | undefined) ??
          aggregate.citationKey,
        abstract:
          (projected.abstract as string | undefined) ?? aggregate.abstract,
        fields: dynamicExtraFields,
      },
      command.options?.expectedVersion,
    );

    await this.itemRepo.save(aggregate);

    return {
      success: true,
      item: toItemResultDto(aggregate),
      conversionReport: preview,
    };
  }
}
