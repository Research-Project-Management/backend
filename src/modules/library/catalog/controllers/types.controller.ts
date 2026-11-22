import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  UseGuards,
  Post,
  Body,
  NotFoundException,
  Header,
  Put,
  Patch,
  HttpCode,
  HttpStatus,
  Optional,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser, Public } from '@/modules/identity/auth';
import {
  ProjectRoleGuard,
  ProjectRoles,
  ProjectAccessGuard,
} from '@/modules/project/access';
import { normalizeProjectSpaceId, isUuid } from '@/modules/library/core';
import { CursorPaginationQueryDto } from '@/modules/library/catalog/dto/items.dto';
import { ItemQueryService } from '@/modules/library/catalog/services/item-query.service';
import { LibraryBootstrapService } from '@/modules/library/catalog/services/bootstrap.service';
import { ReaderBootstrapService } from '@/modules/library/catalog/services/reader-bootstrap.service';
import { TypesService } from '@/modules/library/catalog/services/types.service';
import { SchemaValidatorService } from '@/modules/library/catalog/services/schema-validator.service';
import { StateService } from '@/modules/library/catalog/services/state.service';
import { ValidateItemPayloadDto } from '@/modules/library/catalog/dto/state.dto';


@ApiTags('Library Item Types & Academic Schema')
@ApiBearerAuth()
@Controller(['api/v1/library/types', 'api/v1/library/item-types'])
@UseGuards(JwtAuthGuard)
export class TypeController {
  constructor(
    private readonly typesService: TypesService,
    private readonly schemaValidator: SchemaValidatorService,
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

  @Post('validate')
  validateItemPayload(@Body() body: ValidateItemPayloadDto) {
    const type = body?.itemType || 'journalArticle';
    const data = body?.data || {};
    const validation = this.schemaValidator.validateAndSanitizeItem(type, data);
    return {
      success: validation.valid,
      ...validation,
    };
  }
}

