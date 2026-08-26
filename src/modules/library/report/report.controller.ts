import { Controller, Get, Header, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';
import { ReportService } from './report.service';

@ApiTags('Library - Reports')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  @Get([
    'workspace/:workspaceId/library/items/:itemId/report',
    'library/:workspaceId/items/:itemId/report',
  ])
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary: 'Generate a structured report for one library catalog item',
  })
  async getItemReport(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    const report = await this.reportService.getItemReport(workspaceId, itemId);
    return {
      report,
      html: this.reportService.renderHtml(report),
    };
  }

  @Get([
    'workspace/:workspaceId/library/items/:itemId/report.html',
    'library/:workspaceId/items/:itemId/report.html',
  ])
  @Header('Content-Type', 'text/html; charset=utf-8')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary: 'Render a structured HTML report for one library catalog item',
  })
  async getItemReportHtml(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    const report = await this.reportService.getItemReport(workspaceId, itemId);
    return this.reportService.renderHtml(report);
  }

  @Get([
    'workspace/:workspaceId/library/collections/:collectionId/report',
    'library/:workspaceId/collections/:collectionId/report',
  ])
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary: 'Generate a structured report for an entire collection',
  })
  async getCollectionReport(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
  ) {
    const report = await this.reportService.getCollectionReport(
      workspaceId,
      collectionId,
    );
    return {
      report,
      html: this.reportService.renderCollectionHtml(report),
    };
  }

  @Get([
    'workspace/:workspaceId/library/collections/:collectionId/report.html',
    'library/:workspaceId/collections/:collectionId/report.html',
  ])
  @Header('Content-Type', 'text/html; charset=utf-8')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary: 'Render a structured HTML report for an entire collection',
  })
  async getCollectionReportHtml(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
  ) {
    const report = await this.reportService.getCollectionReport(
      workspaceId,
      collectionId,
    );
    return this.reportService.renderCollectionHtml(report);
  }
}

export { ReportController as LibraryReportController };
