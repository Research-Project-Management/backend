import { TypeConversionPreview } from '../types/items.types';

export const ITEM_TRANSFORMER_PORT = Symbol('ITEM_TRANSFORMER_PORT');

/**
 * Domain Port for Item Schema Transformation & Type Conversion.
 *
 * Clean Architecture & Hexagonal:
 * Application Use Cases depend on this port, keeping business orchestration decoupled
 * from transformer implementation details.
 */
export interface IItemTransformerPort {
  getItemFieldValue(item: Record<string, any>, key: string): any;

  previewConversion(
    rawItem: Record<string, any>,
    targetType: string,
    options?: { retainUnmappedInExtra?: boolean },
  ): TypeConversionPreview;
}
