import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TypesService } from '@/modules/library/catalog/services/types.service';
import { ZoteroSchemaValidatorService } from '@/modules/library/catalog/services/zotero-schema-validator.service';
import { JwtAuthGuard } from '@/modules/identity/auth';

@ApiTags('Library Catalog Types')
@ApiBearerAuth()
@Controller([
  'api/v1/library/item-types',
  'api/v1/library/types',
  'api/v1/projects/:projectId/library/item-types',
  'api/v1/projects/:projectId/library/types',
])
@UseGuards(JwtAuthGuard)
export class TypeController {
  constructor(
    private readonly typesService: TypesService,
    private readonly validator: ZoteroSchemaValidatorService,
  ) {}

  @Get()
  listAllItemTypes() {
    const snapshot = this.typesService.getSnapshot();
    return {
      success: true,
      registryVersion: this.typesService.getSchemaVersion(),
      schemaVersion: this.typesService.getSchemaVersion(),
      source: this.typesService.getSource(),
      itemTypes: this.typesService.getAllItemTypes(),
      data: this.typesService.getAllItemTypes(),
      baseFieldMappings: snapshot.baseFieldMappings,
      reverseBaseFieldMappings: snapshot.reverseBaseFieldMappings,
      creatorRoles: snapshot.creatorRoles,
      cslTypeMap: snapshot.cslTypeMap,
      cslFieldMap: snapshot.cslFieldMap,
    };
  }

  @Get('schema')
  getSchemaSnapshot() {
    const snapshot = this.typesService.getSnapshot();
    return {
      success: true,
      ...snapshot,
      data: snapshot,
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
    @Body() body: Record<string, unknown>,
  ) {
    const result = this.validator.validateAndSanitizeItem(itemType, body || {});
    return {
      success: true,
      result,
    };
  }
}
