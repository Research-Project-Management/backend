import { Controller, Post, Param, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { ExportsService } from './exports.service';
import { ExportLibraryDto } from './dto/export.dto';

@Controller([
  'api/v1/workspaces/:workspaceId/library/exports',
  'api/library/collections/:workspaceId/:collectionId/export-bundle',
  'api/library/exports',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  @Post()
  async exportLibrary(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: ExportLibraryDto,
  ) {
    return this.exportsService.exportLibrary(workspaceId, dto);
  }
}
