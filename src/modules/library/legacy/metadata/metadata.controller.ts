import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { MetadataService } from './metadata.service';
import {
  NormalizeMetadataDto,
  ResolveDoiDto,
  ResolveQueryDto,
} from './dto/metadata.dto';

import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';

@ApiTags('Library - Metadata')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class MetadataController {
  constructor(private readonly metadataService: MetadataService) {}

  @Get([
    'workspace/:workspaceId/library/metadata/schema',
    'library/metadata/schema',
    'workspace/:workspaceId/library/schema',
    'library/schema',
  ])
  @ApiOperation({ summary: 'Get full official Zotero metadata schema with all item types, fields and creator roles' })
  getSchema() {
    return this.metadataService.getItemTypes();
  }

  @Get([
    'workspace/:workspaceId/library/metadata/item-types',
    'library/metadata/item-types',
  ])
  @ApiOperation({ summary: 'List supported library metadata item types' })
  getItemTypes() {
    return this.metadataService.getItemTypes();
  }

  @Get([
    'workspace/:workspaceId/library/metadata/item-types/:itemType',
    'library/metadata/item-types/:itemType',
  ])
  @ApiOperation({
    summary: 'Get metadata fields and creator roles for one item type',
  })
  getItemType(@Param('itemType') itemType: string) {
    return this.metadataService.getItemType(itemType);
  }

  @Get([
    'workspace/:workspaceId/library/metadata/item-types/:itemType/fields',
    'library/metadata/item-types/:itemType/fields',
  ])
  @ApiOperation({ summary: 'Get metadata fields for one item type' })
  getItemTypeFields(@Param('itemType') itemType: string) {
    return {
      itemType,
      fields: this.metadataService.getItemTypeFields(itemType),
    };
  }

  @Get([
    'workspace/:workspaceId/library/metadata/item-types/:itemType/creators',
    'library/metadata/item-types/:itemType/creators',
  ])
  @ApiOperation({ summary: 'Get creator roles for one item type' })
  getItemTypeCreators(@Param('itemType') itemType: string) {
    return {
      itemType,
      creators: this.metadataService.getItemTypeCreators(itemType),
    };
  }

  @Post([
    'workspace/:workspaceId/library/metadata/normalize',
    'library/metadata/normalize',
  ])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Normalize library metadata input without saving' })
  normalize(@Body() dto: NormalizeMetadataDto) {
    return this.metadataService.normalize(dto);
  }

  @Post([
    'workspace/:workspaceId/library/metadata/resolve',
    'library/metadata/resolve',
    'library/references/resolve',
  ])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Resolve academic metadata from any query string (DOI, arXiv ID, URL, Title) across multiple providers',
  })
  async resolve(@Body() dto: ResolveQueryDto) {
    return this.metadataService.resolve(dto.query);
  }

  @Post([
    'workspace/:workspaceId/library/metadata/resolve-doi',
    'library/metadata/resolve-doi',
    'library/references/resolve-doi',
  ])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve academic metadata from a DOI string via CrossRef',
  })
  async resolveDoi(@Body() dto: ResolveDoiDto) {
    return this.metadataService.resolve(dto.doi);
  }

  @Get([
    'workspace/:workspaceId/library/metadata/doi/:doi',
    'library/metadata/doi/:doi',
    'library/references/doi/:doi',
  ])
  @ApiOperation({ summary: 'Lookup academic metadata from a DOI' })
  async resolveDoiParam(@Param('doi') doi: string) {
    const result = await this.metadataService.resolve(doi);
    const work = result?.metadata || null;
    return {
      ...result,
      work,
      metadata: work,
    };
  }

  @Get([
    'library/references/crossref/search',
    'library/references/search',
    'workspace/:workspaceId/library/references/search',
  ])
  @ApiOperation({
    summary:
      'Search academic literature metadata via CrossRef/OpenAlex/SemanticScholar',
  })
  async searchReferences(
    @Query('query') query: string,
    @Query('rows') _rows?: number,
  ) {
    if (!query) {
      return { works: [], totalResults: 0, work: null };
    }
    const result = await this.metadataService.resolve(query);
    const work = result?.metadata || null;
    return {
      works: work ? [work] : [],
      totalResults: work ? 1 : 0,
      work,
      metadata: work,
    };
  }
}
