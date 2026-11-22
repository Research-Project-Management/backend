import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  NotFoundException,
  BadRequestException,
  Header,
} from '@nestjs/common';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { CitationService } from '@/modules/library/citation/services/citation.service';
import {
  FormatCitationDto,
  FormatBatchCitationDto,
  ExportLibraryDto,
  ExportByKeysDto,
} from '@/modules/library/citation/dto/citation.dto';
import { ExportFormatType } from '@/modules/library/citation/types/citation.types';
import { normalizeProjectSpaceId } from '@/modules/library/core';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ProjectAccessGuard,
  ProjectRoles,
  ProjectRole,
} from '@/modules/project/access';
import { ExportsService } from '@/modules/library/citation/services/exports.service';


@ApiTags('Library Exports')
@ApiBearerAuth()
@Controller([
  'api/v1/library/exports',
  'api/v1/spaces/:spaceId/library/exports',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  @Get('items/:itemId/annotated-pdf')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async exportAnnotatedPdf(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Param('spaceId') routeProjectId?: string,
    @Query('spaceId') queryProjectId?: string,
    @Query('attachmentId') attachmentId?: string,
  ) {
    const effectiveProjectId = normalizeProjectSpaceId(
      routeProjectId || queryProjectId,
    );
    return this.exportsService.exportAnnotatedItemPdf(
      userId,
      itemId,
      undefined,
      effectiveProjectId,
      attachmentId,
    );
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async exportLibrary(
    @CurrentUser('id') userId: string,
    @Body() dto: ExportLibraryDto,
    @Param('spaceId') routeProjectId?: string,
  ) {
    if (routeProjectId && !dto.spaceId) {
      dto.spaceId = routeProjectId;
    }
    return this.exportsService.exportLibrary(userId, dto);
  }

  @Post('by-keys')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async exportCitationsBibtex(
    @CurrentUser('id') userId: string,
    @Body() body: ExportByKeysDto,
    @Param('spaceId') routeProjectId?: string,
    @Query('spaceId') queryProjectId?: string,
  ) {
    const effectiveProjectId = normalizeProjectSpaceId(
      routeProjectId || body.spaceId || queryProjectId,
    );
    const result = await this.exportsService.exportByCitationKeys(
      userId,
      body.keys || [],
      effectiveProjectId,
      body.format || 'bibtex',
    );
    return {
      ...result,
      itemCount: result.itemCount ?? result.count,
      filename: result.filename ?? 'references.bib',
      bibtex: result.content,
    };
  }

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async exportLibraryGet(
    @CurrentUser('id') userId: string,
    @Param('spaceId') routeProjectId?: string,
    @Query('format') format?: ExportFormatType,
    @Query('collectionId') collectionIdQuery?: string,
    @Query('tagId') tagId?: string,
    @Query('spaceId') projectIdQuery?: string,
  ) {
    const effectiveProjectId = normalizeProjectSpaceId(
      routeProjectId || projectIdQuery,
    );
    const effectiveFormat = format || 'bibtex';
    const queryDto: ExportLibraryDto = {
      format: effectiveFormat,
      collectionId: collectionIdQuery,
      tagId,
      spaceId: effectiveProjectId,
    };

    const result = await this.exportsService.exportLibrary(userId, queryDto);

    return {
      ...result,
      bibtex: result.content,
      total: result.itemCount,
      filename: result.filename,
    };
  }

  @Get(':collectionId/export-bundle')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getCollectionBundle(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Param('spaceId') routeProjectId?: string,
    @Query('spaceId') queryProjectId?: string,
  ) {
    return this.exportsService.exportBundle(
      userId,
      collectionId,
      normalizeProjectSpaceId(routeProjectId || queryProjectId),
    );
  }
}
