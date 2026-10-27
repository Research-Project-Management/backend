import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  NotFoundException,
  Header,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, Public } from '@/modules/identity/auth';
import { TypesService } from '@/modules/library/catalog/services/types.service';
import { ZoteroSchemaValidatorService } from '@/modules/library/catalog/services/zotero-schema-validator.service';

@ApiTags('Library Item Types & Academic Schema')
@ApiBearerAuth()
@Controller(['api/v1/library/types', 'api/v1/library/item-types'])
@UseGuards(JwtAuthGuard)
export class TypeController {
  constructor(
    private readonly typesService: TypesService,
    private readonly schemaValidator: ZoteroSchemaValidatorService,
  ) {}

  @Public()
  @Get()
  @Header(
    'Cache-Control',
    'public, max-age=86400, stale-while-revalidate=604800',
  )
  listAllItemTypes() {
    const snapshot = this.typesService.getSnapshot();
    const itemTypes = this.typesService.getAllItemTypes();
    return {
      success: true,
      schemaVersion: snapshot.version,
      count: itemTypes.length,
      itemTypes,
      baseFieldMappings: snapshot.baseFieldMappings,
      creatorRoles: snapshot.creatorRoles,
      cslTypeMap: snapshot.cslTypeMap,
      cslFieldMap: snapshot.cslFieldMap,
    };
  }

  @Public()
  @Get('schema')
  @Header(
    'Cache-Control',
    'public, max-age=86400, stale-while-revalidate=604800',
  )
  getSchemaSnapshot() {
    const snapshot = this.typesService.getSnapshot();
    return {
      success: true,
      data: snapshot,
    };
  }

  @Public()
  @Get(':itemType')
  @Header(
    'Cache-Control',
    'public, max-age=86400, stale-while-revalidate=604800',
  )
  getItemTypeDefinition(@Param('itemType') itemType: string) {
    const def = this.typesService.getItemType(itemType);
    if (!def) {
      throw new NotFoundException(
        `Item type '${itemType}' is not a valid academic bibliographic type`,
      );
    }
    return {
      success: true,
      itemType: def,
    };
  }

  @Public()
  @Post('validate')
  validateItemPayload(
    @Body() body: { itemType: string; data: Record<string, unknown> },
  ) {
    const type = body?.itemType || 'journalArticle';
    const data = body?.data || {};
    const validation = this.schemaValidator.validateAndSanitizeItem(type, data);
    return {
      success: validation.valid,
      ...validation,
    };
  }
}
