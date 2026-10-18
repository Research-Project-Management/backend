import {
  MutableItemPayload,
  AttachmentLike,
  ItemIdentifierLike,
  parseJsonObject,
} from './item-mapper.types';
import {
  mapCreatorsPartial,
  harmonizeDomainMetadataAndIdentifiersPartial,
} from './item-bibliographic.mapper';
import {
  unpackMetadataAndExtraPartial,
  mapAttachmentsAndPrimaryFilePartial,
  finalizePrimaryFilePartial,
  mapPublicationsAndRelationsPartial,
} from './item-detail.mapper';
import {
  mapTagsCollectionsNotesPartial,
  mapFlattenedStateHelper,
} from './item-summary.mapper';

export type { MutableItemPayload, AttachmentLike, ItemIdentifierLike };
export {
  parseJsonObject,
  mapCreatorsPartial,
  harmonizeDomainMetadataAndIdentifiersPartial,
  unpackMetadataAndExtraPartial,
  mapAttachmentsAndPrimaryFilePartial,
  finalizePrimaryFilePartial,
  mapPublicationsAndRelationsPartial,
  mapTagsCollectionsNotesPartial,
  mapFlattenedStateHelper,
};

export class ItemsMapper {
  /**
   * Normalizes a single Item record or payload to the canonical domain shape
   * by composing small, single-responsibility partial mappers.
   */
  static toDomain<T>(item: T): T {
    if (!item || typeof item !== 'object') return item;
    const it: MutableItemPayload = { ...(item as MutableItemPayload) };

    unpackMetadataAndExtraPartial(it);
    const primaryPdf = mapAttachmentsAndPrimaryFilePartial(it);
    mapCreatorsPartial(it);
    mapTagsCollectionsNotesPartial(it);
    harmonizeDomainMetadataAndIdentifiersPartial(it);
    finalizePrimaryFilePartial(it, primaryPdf);
    mapPublicationsAndRelationsPartial(it, <U>(x: U) =>
      ItemsMapper.toDomain(x),
    );

    return it as T;
  }

  /**
   * Normalizes an array of Item records.
   */
  static toDomainList<T>(items: T[]): T[] {
    if (!Array.isArray(items)) return items;
    return items.map((item) => ItemsMapper.toDomain(item));
  }

  /**
   * Projects user state (readStatus, rating, lastReadAt) to top level of domain item.
   */
  static mapFlattenedState<T extends Record<string, unknown>>(
    item: T | null | undefined,
    userId?: string,
  ):
    | (T & { readStatus: string; rating: number; lastReadAt: string | null })
    | null {
    return mapFlattenedStateHelper(
      item,
      <U>(x: U) => ItemsMapper.toDomain(x),
      userId,
    );
  }
}
