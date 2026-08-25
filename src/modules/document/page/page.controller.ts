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
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
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
  async getWorkspacePages(@Param('workspaceId') workspaceId: string) {
    return this.pageService.getWorkspacePages(workspaceId);
  }

  @Get('project/:projectId/pages')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  async getProjectPages(@Param('projectId') projectId: string) {
    return this.pageService.getProjectPages(projectId);
  }

  @Post('project/:projectId/pages')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
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
  async getPage(@Param('pageId') pageId: string) {
    return this.pageService.getPage(pageId);
  }

  @Put(['project/:projectId/pages/:pageId', 'pages/:pageId'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  async updatePage(
    @Param('pageId') pageId: string,
    @Body() dto: UpdatePageDto,
  ) {
    return this.pageService.updatePage(pageId, dto);
  }

  @Delete(['project/:projectId/pages/:pageId', 'pages/:pageId'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
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
  async duplicatePage(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.pageService.duplicatePage(pageId, userId);
  }

  @Get(['project/:projectId/pages/:pageId/files', 'pages/:pageId/files'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  async getPageFiles(@Param('pageId') pageId: string) {
    return this.pageService.getPageFiles(pageId);
  }

  @Post(['project/:projectId/pages/:pageId/files', 'pages/:pageId/files'])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
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
  async updateThumbnail(
    @Param('pageId') pageId: string,
    @Body() dto: UpdateThumbnailDto,
  ) {
    return this.pageService.updateThumbnail(pageId, dto.pdfThumbnail);
  }
}
