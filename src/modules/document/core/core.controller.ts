import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
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
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class CoreController {
  constructor(private readonly pageService: CoreService) {}

  @Get('projects/:projectId/pages')
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'List all pages/documents in a project' })
  async getProjectPages(
    @Param('projectId') projectId: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    return this.pageService.getProjectPages(projectId, status, search);
  }

  @Get('projects/:projectId/pages/tree')
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'Get ordered document tree hierarchy for a project',
  })
  async getProjectPageTree(@Param('projectId') projectId: string) {
    return this.pageService.getProjectPageTree(projectId);
  }

  @Post(['pages', 'projects/:projectId/pages'])
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

  @Get(['pages/:pageId', 'projects/:projectId/pages/:pageId'])
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get a single page/document by ID' })
  async getPage(
    @Param('pageId') pageId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.getPage(pageId, projectId);
  }

  @Put(['pages/:pageId', 'projects/:projectId/pages/:pageId'])
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Update page/document content or metadata' })
  async updatePage(
    @Param('pageId') pageId: string,
    @Body() dto: UpdatePageDto,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.updatePage(pageId, dto, projectId, userId);
  }

  @Delete(['pages/:pageId', 'projects/:projectId/pages/:pageId'])
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'Soft delete a page/document' })
  async deletePage(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.deletePage(pageId, projectId, userId);
  }

  @Post(['pages/:pageId/restore', 'projects/:projectId/pages/:pageId/restore'])
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'Restore a soft-deleted page/document' })
  async restorePage(
    @Param('pageId') pageId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.restorePage(pageId, projectId);
  }

  @Post(['pages/:pageId/duplicate', 'projects/:projectId/pages/:pageId/duplicate'])
  @HttpCode(HttpStatus.CREATED)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Duplicate an existing page/document' })
  async duplicatePage(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.duplicatePage(pageId, userId, projectId);
  }

  @Get(['pages/:pageId/files', 'projects/:projectId/pages/:pageId/files'])
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'List files attached to a page/document' })
  async getPageFiles(
    @Param('pageId') pageId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.getPageFiles(pageId, projectId);
  }

  @Post(['pages/:pageId/files', 'projects/:projectId/pages/:pageId/files'])
  @HttpCode(HttpStatus.CREATED)
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

  @Put(['pages/:pageId/main-file', 'projects/:projectId/pages/:pageId/main-file'])
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Set the main/root file of a page' })
  async setMainFile(
    @Param('pageId') pageId: string,
    @Body() dto: SetMainFileDto,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.setMainFile(pageId, dto.mainFileId, projectId);
  }

  @Put(['pages/:pageId/thumbnail', 'projects/:projectId/pages/:pageId/thumbnail'])
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
