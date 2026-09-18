import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { TypesService } from './types.service';
import { ZoteroSchemaValidatorService } from './services/zotero-schema-validator.service';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/auth.guard';

@Controller(['api/v1/library/item-types'])
@UseGuards(JwtAuthGuard)
export class TypesController {
  constructor(
    private readonly typesService: TypesService,
    private readonly validator: ZoteroSchemaValidatorService,
  ) {}

  @Get()
  listAllItemTypes() {
    return {
      success: true,
      registryVersion: this.typesService.getSchemaVersion(),
      schemaVersion: this.typesService.getSchemaVersion(),
      source: this.typesService.getSource(),
      itemTypes: this.typesService.getAllItemTypes(),
      data: this.typesService.getAllItemTypes(),
    };
  }

  @Get(':itemType')
  getItemTypeDefinition(@Param('itemType') itemType: string) {
    const definition = this.typesService.getItemType(itemType);
    if (!definition) {
      throw new NotFoundException(
        `Item type '${itemType}' not found in Library registry`,
      );
    }
    return { success: true, itemType: definition, data: definition };
  }

  @Get(':itemType/fields')
  getItemTypeFields(@Param('itemType') itemType: string) {
    const definition = this.typesService.getItemType(itemType);
    if (!definition) {
      throw new NotFoundException(
        `Item type '${itemType}' not found in Library registry`,
      );
    }
    return {
      success: true,
      itemType: definition.itemType,
      fields: definition.fields,
      count: definition.fields.length,
    };
  }

  @Get(':itemType/creator-types')
  getItemTypeCreatorTypes(@Param('itemType') itemType: string) {
    const definition = this.typesService.getItemType(itemType);
    if (!definition) {
      throw new NotFoundException(
        `Item type '${itemType}' not found in Library registry`,
      );
    }
    return {
      success: true,
      itemType: definition.itemType,
      primaryCreatorType: definition.primaryCreatorType,
      creatorTypes: definition.creatorTypes,
    };
  }

  @Get(':itemType/csl')
  getItemTypeCslMapping(@Param('itemType') itemType: string) {
    const definition = this.typesService.getItemType(itemType);
    if (!definition) {
      throw new NotFoundException(
        `Item type '${itemType}' not found in Library registry`,
      );
    }
    const cslType = this.typesService.getCslType(itemType);
    return {
      success: true,
      itemType: definition.itemType,
      cslType,
    };
  }

  @Post(':itemType/validate')
  validateItemAgainstSchema(
    @Param('itemType') itemType: string,
    @Body() body: Record<string, any>,
  ) {
    const result = this.validator.validateAndSanitizeItem(itemType, body || {});
    return {
      success: true,
      result,
    };
  }
}
