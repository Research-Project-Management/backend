import { Injectable } from '@nestjs/common';
import {
  CreatorTypeDefinition,
  ItemFieldDefinition,
  ItemTypeDefinition,
  SchemaRegistrySnapshot,
} from '@/modules/library/core/types/schema.types';
import { SCHEMA_V42_DATA } from '@/modules/library/core/types/schema.constants';
import {
  getEffectiveBaseFieldMap,
  getEffectiveReverseBaseFieldMap,
  normalizeCanonicalItemType,
} from '@/modules/library/core';
import {
  normalizeSchemaTypeKey,
  isSchemaValidItemType,
  getSchemaOrderedFields,
  getSchemaValidCreatorTypes,
  getSchemaPrimaryCreatorType,
} from '@/modules/library/catalog/domain/item-schema.policy';

@Injectable()
export class TypesService {
  private readonly snapshot: SchemaRegistrySnapshot = SCHEMA_V42_DATA;

  getSnapshot(): SchemaRegistrySnapshot {
    return this.snapshot;
  }

  getAllItemTypes(includeSpecial = false): ItemTypeDefinition[] {
    const types = Object.values(this.snapshot.itemTypes);
    return includeSpecial
      ? types
      : types.filter((t: ItemTypeDefinition) => t.isBibliographic);
  }

  getItemType(itemType: string): ItemTypeDefinition | undefined {
    if (!itemType) return undefined;
    return this.snapshot.itemTypes[this.normalizeTypeKey(itemType)];
  }

  isValidItemType(itemType: string): boolean {
    return isSchemaValidItemType(itemType, this.snapshot);
  }

  isBibliographic(itemType: string): boolean {
    return this.getItemType(itemType)?.isBibliographic ?? false;
  }

  isSpecial(itemType: string): boolean {
    return this.getItemType(itemType)?.isSpecial ?? false;
  }

  getOrderedFields(itemType: string): ItemFieldDefinition[] {
    return getSchemaOrderedFields(itemType, this.snapshot);
  }

  isValidFieldForType(itemType: string, fieldKey: string): boolean {
    const def = this.getItemType(itemType);
    return def
      ? def.fields.some((f: ItemFieldDefinition) => f.key === fieldKey)
      : false;
  }

  getValidCreatorTypes(itemType: string): CreatorTypeDefinition[] {
    return getSchemaValidCreatorTypes(itemType, this.snapshot);
  }

  getPrimaryCreatorType(itemType: string): string {
    return getSchemaPrimaryCreatorType(itemType, this.snapshot);
  }

  getBaseFieldMapping(itemType: string): Record<string, string> {
    const normalized = this.normalizeTypeKey(itemType);
    return {
      ...getEffectiveBaseFieldMap(normalized),
      ...(this.snapshot.baseFieldMappings[normalized] || {}),
    };
  }

  getReverseBaseFieldMapping(itemType: string): Record<string, string> {
    const normalized = this.normalizeTypeKey(itemType);
    return {
      ...getEffectiveReverseBaseFieldMap(normalized),
      ...(this.snapshot.reverseBaseFieldMappings[normalized] || {}),
    };
  }

  getBaseFieldFor(itemType: string, fieldKey: string): string | undefined {
    const reverse = this.getReverseBaseFieldMapping(itemType);
    return reverse[fieldKey] || fieldKey;
  }

  getTypeSpecificFieldFor(
    itemType: string,
    baseField: string,
  ): string | undefined {
    const mapping = this.getBaseFieldMapping(itemType);
    return mapping[baseField] || baseField;
  }

  resolveBaseFieldMapping(
    fromType: string,
    toType: string,
    fieldKey: string,
  ): { targetField: string; baseSemantic: string } | undefined {
    const baseField = this.getBaseFieldFor(fromType, fieldKey);
    if (!baseField) return undefined;
    const targetField = this.getTypeSpecificFieldFor(toType, baseField);
    if (!targetField) return undefined;
    return { targetField, baseSemantic: baseField };
  }

  normalizeItemType(rawType: string | undefined | null): string {
    return normalizeCanonicalItemType(rawType, this.snapshot.itemTypes);
  }

  private normalizeTypeKey(key: string): string {
    return normalizeSchemaTypeKey(key, this.snapshot);
  }
}
