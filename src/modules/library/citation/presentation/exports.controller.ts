import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  Optional,
} from '@nestjs/common';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ExportsService } from '../application/services/exports.service';
import { ExportLibraryUseCase } from '../application/queries/export-library.use-case';
import { ExportBibliographyUseCase } from '../application/queries/export-bibliography.use-case';
import { ExportAnnotatedPdfUseCase } from '../application/queries/export-annotated-pdf.use-case';
import {
  ExportLibraryDto,
  ExportFormatType,
} from '../application/dtos/exports.dto';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

@Controller([
  'api/v1/library/exports',
  'api/v1/projects/:projectId/library/exports',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class ExportsController {
  constructor(
    @Optional() private readonly exportsService?: ExportsService,
    @Optional() private readonly exportLibraryUseCase?: ExportLibraryUseCase,
    @Optional()
    private readonly exportBibliographyUseCase?: ExportBibliographyUseCase,
    @Optional()
    private readonly exportAnnotatedPdfUseCase?: ExportAnnotatedPdfUseCase,
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
    if (this.exportAnnotatedPdfUseCase) {
      return this.exportAnnotatedPdfUseCase.execute({
        userId,
        itemId,
        projectId: effectiveProjectId,
      });
    }
    const res = await this.exportsService!.exportAnnotatedItemPdf(
      userId,
      itemId,
      undefined,
      effectiveProjectId,
    );
    return {
      filename: res.filename,
      mimeType: 'application/pdf',
      base64: Buffer.from(res.buffer).toString('base64'),
    };
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
    if (this.exportLibraryUseCase) {
      return this.exportLibraryUseCase.execute({ userId, dto });
    }
    return this.exportsService!.exportLibrary(userId, dto);
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
    if (this.exportBibliographyUseCase) {
      return this.exportBibliographyUseCase.execute({
        userId,
        citeKeys: body.keys || [],
        projectId: effectiveProjectId,
      });
    }
    return this.exportsService!.exportByCitationKeys(
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

    const result = this.exportLibraryUseCase
      ? await this.exportLibraryUseCase.execute({ userId, dto: queryDto })
      : await this.exportsService!.exportLibrary(userId, queryDto);

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
    return this.exportsService!.exportBundle(userId, collectionId);
  }
}
