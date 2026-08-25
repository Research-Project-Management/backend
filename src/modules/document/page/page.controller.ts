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
import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authn';
import {
  WorkspaceRoleGuard,
  WorkspaceRoles,
  ProjectRoleGuard,
  ProjectRoles,
} from '@/modules/iam/authz';

@ApiTags('Manuscript')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class PageController {
  constructor(private readonly pageService: PageService) {}

  @Get('workspace/:workspaceId/pages')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'List all pages in a workspace' })
  async getWorkspacePages(@Param('workspaceId') workspaceId: string) {
    return this.pageService.getWorkspacePages(workspaceId);
  }

  @Get('project/:projectId/pages')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'List all pages in a project' })
  async getProjectPages(@Param('projectId') projectId: string) {
    return this.pageService.getProjectPages(projectId);
  }

  @Post('project/:projectId/pages')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Create a new page in a project' })
  async createPage(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreatePageDto,
  ) {
    return this.pageService.createPage('', projectId, userId, dto);
  }

  @Get(['project/:projectId/pages/:pageId', 'pages/:pageId'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get a single page by ID' })
  async getPage(@Param('pageId') pageId: string) {
    return this.pageService.getPage(pageId);
  }

  @Put(['project/:projectId/pages/:pageId', 'pages/:pageId'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Update page content or metadata' })
  async updatePage(
    @Param('pageId') pageId: string,
    @Body() dto: UpdatePageDto,
  ) {
    return this.pageService.updatePage(pageId, dto);
  }

  @Delete(['project/:projectId/pages/:pageId', 'pages/:pageId'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({ summary: 'Delete a page (soft delete)' })
  async deletePage(@Param('pageId') pageId: string) {
    return this.pageService.deletePage(pageId);
  }

  @Post([
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

  @Get(['project/:projectId/pages/:pageId/files', 'pages/:pageId/files'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'List files attached to a page' })
  async getPageFiles(@Param('pageId') pageId: string) {
    return this.pageService.getPageFiles(pageId);
  }

  @Post(['project/:projectId/pages/:pageId/files', 'pages/:pageId/files'])
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
