import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import {
  SchemaValidationResult,
  CreatorHarmonizationChange,
} from '@/modules/library/core/types/schema.types';
import { CreatorCreditInput } from '@/modules/library/core';
import {
  validateAndHarmonizeSchemaCreators,
  validateAndSanitizeSchemaFields,
} from '@/modules/library/catalog/domain/item-schema.policy';
import { TypesService } from './types.service';

@Injectable()
export class SchemaValidatorService {
  private readonly logger = new Logger(SchemaValidatorService.name);

  constructor(private readonly typesService: TypesService) {}

  validateItemType(rawType?: string | null): string {
    const normalized = this.typesService.normalizeItemType(rawType);
    if (!this.typesService.isValidItemType(normalized)) {
      throw new BadRequestException(
        `Invalid itemType '${rawType}'. Must be one of registered Zotero schema types.`,
      );
    }
    return normalized;
  }

  validateAndHarmonizeCreators(
    itemType: string,
    creators?: CreatorCreditInput[],
  ): {
    creators: CreatorCreditInput[];
    changes: CreatorHarmonizationChange[];
  } {
    return validateAndHarmonizeSchemaCreators(itemType, creators, {
      validCreatorTypes: this.typesService.getValidCreatorTypes(itemType),
      primaryCreatorType: this.typesService.getPrimaryCreatorType(itemType),
      onHarmonized: (msg) => this.logger.log(msg),
    });
  }

  validateAndSanitizeFields(
    itemType: string,
    data: Record<string, unknown>,
  ): {
    cleanFields: Record<string, unknown>;
    demotedToExtra: Record<string, unknown>;
    warnings: string[];
  } {
    return validateAndSanitizeSchemaFields(itemType, data, {
      orderedFields: this.typesService.getOrderedFields(itemType),
      onWarning: (msg) => this.logger.debug(msg),
    });
  }

  validateAndSanitizeItem(
    rawType: string | undefined | null,
    rawData: Record<string, unknown>,
  ): SchemaValidationResult {
    const itemType = this.validateItemType(
      rawType ||
        (rawData.itemType as string | undefined) ||
        (typeof rawData.type === 'string' &&
        this.typesService.isValidItemType(rawData.type.trim())
          ? rawData.type.trim()
          : undefined),
    );

    let creators = rawData.creators as CreatorCreditInput[] | undefined;
    let changes: CreatorHarmonizationChange[] = [];
    if (rawData.creators !== undefined) {
      const harm = this.validateAndHarmonizeCreators(
        itemType,
        rawData.creators as CreatorCreditInput[],
      );
      creators = harm.creators;
      changes = harm.changes;
    }

    const hasExplicitItemType = Boolean(
      rawType || typeof rawData.itemType === 'string',
    );
    let resolvedTypeVal: string | null | undefined = itemType;
    if (rawData.type === null) {
      resolvedTypeVal = null;
    } else if (typeof rawData.type === 'string') {
      const trimmedType = rawData.type.trim();
      if (trimmedType === '') {
        resolvedTypeVal = '';
      } else if (
        trimmedType.toLowerCase() !== itemType.toLowerCase() &&
        (hasExplicitItemType || !this.typesService.isValidItemType(trimmedType))
      ) {
        resolvedTypeVal = trimmedType;
      }
    }

    const dataWithCreators: Record<string, unknown> = {
      ...rawData,
      itemType,
      type: resolvedTypeVal,
      ...(rawData.creators !== undefined ? { creators } : {}),
    };

    const { cleanFields, demotedToExtra, warnings } =
      this.validateAndSanitizeFields(itemType, dataWithCreators);

    if (rawData.creators === undefined) delete cleanFields.creators;

    return {
      valid: true,
      itemType,
      sanitizedItem: cleanFields,
      warnings,
      demotedToExtra,
      creatorChanges: changes,
    };
  }
}
