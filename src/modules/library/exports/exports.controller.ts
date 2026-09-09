import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '../../../modules/iam/authz/decorators/workspace-roles.decorator';
import { ExportsService } from './exports.service';
import { ExportLibraryDto, ExportFormatType } from './dto/exports.dto';

@Controller([
  'api/v1/workspaces/:workspaceId/library/exports',
  'api/v1/workspace/:workspaceId/library/exports',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  @Get('items/:itemId/annotated-pdf')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async exportAnnotatedPdf(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    const res = await this.exportsService.exportAnnotatedItemPdf(
      workspaceId,
      itemId,
    );
    return {
      filename: res.filename,
      mimeType: 'application/pdf',
      base64: Buffer.from(res.buffer).toString('base64'),
    };
  }

  @Post()
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async exportLibrary(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: ExportLibraryDto,
  ) {
    return this.exportsService.exportLibrary(workspaceId, dto);
  }

  @Post('citations/bibtex')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async exportCitationsBibtex(
    @Param('workspaceId') workspaceId: string,
    @Body() body: { keys: string[] },
  ) {
    return this.exportsService.exportByCitationKeys(
      workspaceId,
      body.keys || [],
    );
  }

  @Get()
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async exportLibraryGet(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionIdParam: string | undefined,
    @Query('format') format?: ExportFormatType,
    @Query('collectionId') collectionIdQuery?: string,
    @Query('tagId') tagId?: string,
  ) {
    const targetCollectionId = collectionIdParam || collectionIdQuery;
    if (collectionIdParam) {
      return this.exportsService.exportBundle(workspaceId, collectionIdParam);
    }

    const effectiveFormat = format || 'bibtex';
    const result = await this.exportsService.exportLibrary(workspaceId, {
      format: effectiveFormat,
      collectionId: targetCollectionId,
      tagId,
    });

    return {
      ...result,
      bibtex: result.content,
      total: result.itemCount,
      filename: result.filename,
    };
  }

  @Get(':collectionId/export-bundle')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getCollectionBundle(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
  ) {
    return this.exportsService.exportBundle(workspaceId, collectionId);
  }
}
