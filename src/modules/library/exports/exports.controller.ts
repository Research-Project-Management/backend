import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '../../../modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '../../../modules/iam/authz/decorators/role.decorator';
import { ExportsService } from './exports.service';
import { ExportLibraryDto, ExportFormatType } from './dto/exports.dto';

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
    const res = await this.exportsService.exportAnnotatedItemPdf(
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
    return this.exportsService.exportByCitationKeys(
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
    const result = await this.exportsService.exportLibrary(userId, {
      format: effectiveFormat,
      collectionId: collectionIdQuery,
      tagId,
      projectId: effectiveProjectId,
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
