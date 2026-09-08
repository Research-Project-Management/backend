import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { PageService } from './page.service';
import {
  CreatePageDto,
  UpdatePageDto,
  SetMainFileDto,
  UpdateThumbnailDto,
} from './dto/page.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';

@ApiTags('Manuscript')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class PageController {
  constructor(private readonly pageService: PageService) {}

  @Get(['workspaces/:workspaceId/pages', 'workspace/:workspaceId/pages'])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'List all pages in a workspace' })
  async getWorkspacePages(@Param('workspaceId') workspaceId: string) {
    return this.pageService.getWorkspacePages(workspaceId);
  }

  @Get(['projects/:projectId/pages', 'project/:projectId/pages'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'List all pages in a project' })
  async getProjectPages(@Param('projectId') projectId: string) {
    return this.pageService.getProjectPages(projectId);
  }

  @Get(['projects/:projectId/pages/tree', 'project/:projectId/pages/tree'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'Get ordered document tree hierarchy for a project',
  })
  async getProjectPageTree(@Param('projectId') projectId: string) {
    return this.pageService.getProjectPageTree(projectId);
  }

  @Post([
    'projects/:projectId/pages',
    'project/:projectId/pages',
    'workspaces/:workspaceId/pages',
    'workspace/:workspaceId/pages',
    'pages',
  ])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new page in a project or workspace' })
  async createPage(
    @CurrentUser('id') userId: string,
    @Body() dto: CreatePageDto,
    @Param('projectId') projectId?: string,
    @Param('workspaceId') workspaceId?: string,
  ) {
    const effectiveProjectId = projectId || dto.projectId || '';
    const effectiveWorkspaceId = workspaceId || dto.workspaceId || '';
    return this.pageService.createPage(
      effectiveWorkspaceId,
      effectiveProjectId,
      userId,
      dto,
    );
  }

  @Get([
    'projects/:projectId/pages/:pageId',
    'project/:projectId/pages/:pageId',
    'pages/:pageId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get a single page by ID' })
  async getPage(@Param('pageId') pageId: string) {
    return this.pageService.getPage(pageId);
  }

  @Put([
    'projects/:projectId/pages/:pageId',
    'project/:projectId/pages/:pageId',
    'pages/:pageId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Update page content or metadata' })
  async updatePage(
    @Param('pageId') pageId: string,
    @Body() dto: UpdatePageDto,
  ) {
    return this.pageService.updatePage(pageId, dto);
  }

  @Delete([
    'projects/:projectId/pages/:pageId',
    'project/:projectId/pages/:pageId',
    'pages/:pageId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({ summary: 'Soft delete a page' })
  async deletePage(@Param('pageId') pageId: string) {
    return this.pageService.deletePage(pageId);
  }

  @Post([
    'projects/:projectId/pages/:pageId/restore',
    'project/:projectId/pages/:pageId/restore',
    'pages/:pageId/restore',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({ summary: 'Restore a soft-deleted page' })
  async restorePage(@Param('pageId') pageId: string) {
    return this.pageService.restorePage(pageId);
  }

  @Post([
    'projects/:projectId/pages/:pageId/duplicate',
    'project/:projectId/pages/:pageId/duplicate',
    'pages/:pageId/duplicate',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Duplicate an existing page' })
  async duplicatePage(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.pageService.duplicatePage(pageId, userId);
  }

  @Get([
    'projects/:projectId/pages/:pageId/files',
    'project/:projectId/pages/:pageId/files',
    'pages/:pageId/files',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'List files attached to a page' })
  async getPageFiles(@Param('pageId') pageId: string) {
    return this.pageService.getPageFiles(pageId);
  }

  @Post([
    'projects/:projectId/pages/:pageId/files',
    'project/:projectId/pages/:pageId/files',
    'pages/:pageId/files',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Create a sub-file (child page) within a page' })
  async createPageFile(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body()
    dto: {
      title: string;
      content?: any;
      parentPageId?: string;
    },
  ) {
    return this.pageService.createPageFile(pageId, userId, dto);
  }

  @Put([
    'projects/:projectId/pages/:pageId/main-file',
    'project/:projectId/pages/:pageId/main-file',
    'pages/:pageId/main-file',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Set the main/root file of a page' })
  async setMainFile(
    @Param('pageId') pageId: string,
    @Body() dto: SetMainFileDto,
  ) {
    return this.pageService.setMainFile(pageId, dto.mainFileId);
  }

  @Put([
    'projects/:projectId/pages/:pageId/thumbnail',
    'project/:projectId/pages/:pageId/thumbnail',
    'pages/:pageId/thumbnail',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Update page PDF thumbnail' })
  async updateThumbnail(
    @Param('pageId') pageId: string,
    @Body() dto: UpdateThumbnailDto,
  ) {
    return this.pageService.updateThumbnail(pageId, dto.pdfThumbnail);
  }
}
