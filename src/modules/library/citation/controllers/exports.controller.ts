import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ExportsService } from '@/modules/library/citation/services/exports.service';
import {
  ExportLibraryDto,
  ExportFormatType,
} from '@/modules/library/citation/dto/citation.dto';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';
import { normalizeProjectScopeId } from '@/modules/library/core';

@ApiTags('Library Exports')
@ApiBearerAuth()
@Controller([
  'api/v1/library/exports',
  'api/v1/projects/:projectId/library/exports',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  @Get('items/:itemId/annotated-pdf')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async exportAnnotatedPdf(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Param('projectId') routeProjectId?: string,
    @Query('projectId') queryProjectId?: string,
    @Query('attachmentId') attachmentId?: string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(
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
    @Param('projectId') routeProjectId?: string,
  ) {
    if (routeProjectId && !dto.projectId) {
      dto.projectId = routeProjectId;
    }
    return this.exportsService.exportLibrary(userId, dto);
  }

  @Post('by-keys')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async exportCitationsBibtex(
    @CurrentUser('id') userId: string,
    @Body()
    body: { keys: string[]; projectId?: string; format?: ExportFormatType },
    @Param('projectId') routeProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(
      routeProjectId || body.projectId || queryProjectId,
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
    @Param('projectId') routeProjectId?: string,
    @Query('format') format?: ExportFormatType,
    @Query('collectionId') collectionIdQuery?: string,
    @Query('tagId') tagId?: string,
    @Query('projectId') projectIdQuery?: string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(
      routeProjectId || projectIdQuery,
    );
    const effectiveFormat = format || 'bibtex';
    const queryDto: ExportLibraryDto = {
      format: effectiveFormat,
      collectionId: collectionIdQuery,
      tagId,
      projectId: effectiveProjectId,
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
    @Param('projectId') routeProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.exportsService.exportBundle(
      userId,
      collectionId,
      normalizeProjectScopeId(routeProjectId || queryProjectId),
    );
  }
}
