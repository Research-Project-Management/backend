import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  ITEM_TRANSFORMER_PORT,
  IItemTransformerPort,
} from '../../domain/ports/item-transformer.port';
import {
  TypeConversionPreview,
  ConvertTypeOptions,
} from '../../domain/types/items.types';

export interface PreviewTypeConversionQuery {
  item: Record<string, any>;
  targetType: string;
  options?: ConvertTypeOptions;
}

@Injectable()
export class PreviewTypeConversionUseCase {
  private readonly logger = new Logger(PreviewTypeConversionUseCase.name);

  constructor(
    @Inject(ITEM_TRANSFORMER_PORT)
    private readonly transformer: IItemTransformerPort,
  ) {}

  execute(query: PreviewTypeConversionQuery): TypeConversionPreview {
    const { item, targetType, options } = query;
    return this.transformer.previewConversion(item, targetType, {
      retainUnmappedInExtra: options?.retainUnmappedInExtra ?? true,
    });
  }
}
