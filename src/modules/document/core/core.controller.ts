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
import { CoreService } from './core.service';
import {
  CreatePageDto,
  UpdatePageDto,
  SetMainFileDto,
  UpdateThumbnailDto,
} from './dto/core.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

@ApiTags('Document - Core')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class CoreController {
  constructor(private readonly pageService: CoreService) {}

  @Get([
    'projects/:projectId/pages',
    'project/:projectId/pages',
    'projects/:projectId/documents',
    'project/:projectId/documents',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'List all pages/documents in a project' })
  async getProjectPages(@Param('projectId') projectId: string) {
    return this.pageService.getProjectPages(projectId);
  }

  @Get([
    'projects/:projectId/pages/tree',
    'project/:projectId/pages/tree',
    'projects/:projectId/documents/tree',
    'project/:projectId/documents/tree',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'Get ordered document tree hierarchy for a project',
  })
  async getProjectPageTree(@Param('projectId') projectId: string) {
    return this.pageService.getProjectPageTree(projectId);
  }

  @Post([
    'projects/:projectId/pages',
    'project/:projectId/pages',
    'projects/:projectId/documents',
    'project/:projectId/documents',
    'pages',
    'documents',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new page/document in a project' })
  async createPage(
    @CurrentUser('id') userId: string,
    @Body() dto: CreatePageDto,
    @Param('projectId') projectId?: string,
  ) {
    const effectiveProjectId = projectId || dto.projectId || '';
    return this.pageService.createPage(effectiveProjectId, userId, dto);
  }

  @Get([
    'projects/:projectId/pages/:pageId',
    'project/:projectId/pages/:pageId',
    'projects/:projectId/documents/:pageId',
    'project/:projectId/documents/:pageId',
    'pages/:pageId',
    'documents/:pageId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get a single page/document by ID' })
  async getPage(
    @Param('pageId') pageId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.getPage(pageId, projectId);
  }

  @Put([
    'projects/:projectId/pages/:pageId',
    'project/:projectId/pages/:pageId',
    'projects/:projectId/documents/:pageId',
    'project/:projectId/documents/:pageId',
    'pages/:pageId',
    'documents/:pageId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Update page/document content or metadata' })
  async updatePage(
    @Param('pageId') pageId: string,
    @Body() dto: UpdatePageDto,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.updatePage(pageId, dto, projectId);
  }

  @Delete([
    'projects/:projectId/pages/:pageId',
    'project/:projectId/pages/:pageId',
    'projects/:projectId/documents/:pageId',
    'project/:projectId/documents/:pageId',
    'pages/:pageId',
    'documents/:pageId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'Soft delete a page/document' })
  async deletePage(
    @Param('pageId') pageId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.deletePage(pageId, projectId);
  }

  @Post([
    'projects/:projectId/pages/:pageId/restore',
    'project/:projectId/pages/:pageId/restore',
    'projects/:projectId/documents/:pageId/restore',
    'project/:projectId/documents/:pageId/restore',
    'pages/:pageId/restore',
    'documents/:pageId/restore',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'Restore a soft-deleted page/document' })
  async restorePage(
    @Param('pageId') pageId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.restorePage(pageId, projectId);
  }

  @Post([
    'projects/:projectId/pages/:pageId/duplicate',
    'project/:projectId/pages/:pageId/duplicate',
    'projects/:projectId/documents/:pageId/duplicate',
    'project/:projectId/documents/:pageId/duplicate',
    'pages/:pageId/duplicate',
    'documents/:pageId/duplicate',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Duplicate an existing page/document' })
  async duplicatePage(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.duplicatePage(pageId, userId, projectId);
  }

  @Get([
    'projects/:projectId/pages/:pageId/files',
    'project/:projectId/pages/:pageId/files',
    'projects/:projectId/documents/:pageId/files',
    'project/:projectId/documents/:pageId/files',
    'pages/:pageId/files',
    'documents/:pageId/files',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'List files attached to a page/document' })
  async getPageFiles(
    @Param('pageId') pageId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.getPageFiles(pageId, projectId);
  }

  @Post([
    'projects/:projectId/pages/:pageId/files',
    'project/:projectId/pages/:pageId/files',
    'projects/:projectId/documents/:pageId/files',
    'project/:projectId/documents/:pageId/files',
    'pages/:pageId/files',
    'documents/:pageId/files',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
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
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.createPageFile(pageId, userId, dto, projectId);
  }

  @Put([
    'projects/:projectId/pages/:pageId/main-file',
    'project/:projectId/pages/:pageId/main-file',
    'projects/:projectId/documents/:pageId/main-file',
    'project/:projectId/documents/:pageId/main-file',
    'pages/:pageId/main-file',
    'documents/:pageId/main-file',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Set the main/root file of a page' })
  async setMainFile(
    @Param('pageId') pageId: string,
    @Body() dto: SetMainFileDto,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.setMainFile(pageId, dto.mainFileId, projectId);
  }

  @Put([
    'projects/:projectId/pages/:pageId/thumbnail',
    'project/:projectId/pages/:pageId/thumbnail',
    'projects/:projectId/documents/:pageId/thumbnail',
    'project/:projectId/documents/:pageId/thumbnail',
    'pages/:pageId/thumbnail',
    'documents/:pageId/thumbnail',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Update page PDF thumbnail' })
  async updateThumbnail(
    @Param('pageId') pageId: string,
    @Body() dto: UpdateThumbnailDto,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.updateThumbnail(
      pageId,
      dto.pdfThumbnail,
      projectId,
    );
  }
}

export const PageController = CoreController;
export type PageController = CoreController;
