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
import { ExportsService } from '../services/exports.service';
import { ExportLibraryDto, ExportFormatType } from '../dto/exports.dto';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

@Controller([
  'api/v1/library/exports',
  'api/v1/projects/:projectId/library/exports',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  @Get('items/:itemId/annotated-pdf')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async exportAnnotatedPdf(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Param('projectId') routeProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const effectiveProjectId = routeProjectId || queryProjectId;
    return this.exportsService.exportAnnotatedPdf(
      userId,
      itemId,
      effectiveProjectId,
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

  @Post('citations/bibtex')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async exportCitationsBibtex(
    @CurrentUser('id') userId: string,
    @Body() body: { keys: string[]; projectId?: string },
    @Param('projectId') routeProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const effectiveProjectId =
      routeProjectId || body.projectId || queryProjectId;
    return this.exportsService.exportBibliography(
      userId,
      body.keys || [],
      effectiveProjectId,
    );
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
    const effectiveProjectId = routeProjectId || projectIdQuery;
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
  ) {
    return this.exportsService.exportBundle(userId, collectionId);
  }
}
