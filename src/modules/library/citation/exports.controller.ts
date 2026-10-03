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
import { ExportsService } from './core/services/exports.service';
import { ExportLibraryUseCase } from './core/use-cases/export-library.use-case';
import { ExportBibliographyUseCase } from './core/use-cases/export-bibliography.use-case';
import { ExportAnnotatedPdfUseCase } from './core/use-cases/export-annotated-pdf.use-case';
import { ExportLibraryDto, ExportFormatType } from './dto/exports.dto';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

@Controller([
  'api/v1/library/exports',
  'api/v1/projects/:projectId/library/exports',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class ExportsController {
  constructor(
    private readonly exportAnnotatedPdfUseCase: ExportAnnotatedPdfUseCase,
    private readonly exportLibraryUseCase: ExportLibraryUseCase,
    private readonly exportBibliographyUseCase: ExportBibliographyUseCase,
    private readonly exportsService: ExportsService,
  ) {}

  @Get('items/:itemId/annotated-pdf')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async exportAnnotatedPdf(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Param('projectId') routeProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const effectiveProjectId = routeProjectId || queryProjectId;
    return this.exportAnnotatedPdfUseCase.execute({
      userId,
      itemId,
      projectId: effectiveProjectId,
    });
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
    return this.exportLibraryUseCase.execute({ userId, dto });
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
    return this.exportBibliographyUseCase.execute({
      userId,
      citeKeys: body.keys || [],
      projectId: effectiveProjectId,
    });
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

    const result = await this.exportLibraryUseCase.execute({
      userId,
      dto: queryDto,
    });

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

export const ExportController = ExportsController;
export type ExportController = ExportsController;
