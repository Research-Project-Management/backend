import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { FastifyRequest, FastifyReply } from 'fastify';
import { FileService } from './file.service';
import {
  PresignDto,
  UploadFileDto,
  CreateFolderDto,
  UpdateFileDto,
  RenameFileDto,
  MoveFileDto,
  ShareFileDto,
  BatchFileIdsDto,
  BatchStarDto,
} from './dto/file.dto';
import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authentication';
import {
  WorkspaceRoleGuard,
  WorkspaceRoles,
  ProjectRoleGuard,
  ProjectRoles,
  CurrentWorkspace,
} from '@/modules/iam/authorization';

@ApiTags('Storage & Assets')
@ApiBearerAuth('JWT-auth')
@Controller('api/files')
@UseGuards(JwtAuthGuard)
export class FileController {
  constructor(private readonly fileService: FileService) {}

  @Post('presign')
  @HttpCode(HttpStatus.OK)
  async presign(@Body() dto: PresignDto) {
    return this.fileService.presign(dto);
  }

  /**
   * Multipart Upload endpoint streaming directly to Cloudflare R2 / S3.
   */
  @Post('upload-r2')
  @HttpCode(HttpStatus.CREATED)
  async uploadR2(
    @Req() req: FastifyRequest,
    @CurrentUser('id') userId: string,
  ) {
    const isMultipart = req.isMultipart();
    if (!isMultipart) {
      throw new BadRequestException('Request must be multipart/form-data');
    }

    const data = await req.file();
    if (!data) {
      throw new BadRequestException('No file found in request');
    }

    const buffer = await data.toBuffer();
    const filename = data.filename || 'unnamed-file';
    const mimeType = data.mimetype || 'application/octet-stream';

    // Parse additional fields if any
    const authorId =
      userId || (req as any)?.user?.id || (req as any)?.user?.sub || '';
    const fields = (data.fields || {}) as Record<string, any>;
    const workspaceId =
      typeof fields?.workspaceId?.value === 'string'
        ? fields.workspaceId.value
        : typeof fields?.workspaceId === 'string'
          ? fields.workspaceId
          : undefined;
    const projectId =
      typeof fields?.projectId?.value === 'string'
        ? fields.projectId.value
        : typeof fields?.projectId === 'string'
          ? fields.projectId
          : undefined;
    const pageId =
      typeof fields?.pageId?.value === 'string'
        ? fields.pageId.value
        : typeof fields?.pageId === 'string'
          ? fields.pageId
          : undefined;

    return this.fileService.uploadR2Buffer(
      authorId,
      filename,
      buffer,
      mimeType,
      {
        workspaceId,
        projectId,
        pageId,
      },
    );
  }

  /**
   * Serve / Stream R2 File by storage key
   */
  @Get('r2/*')
  async getR2File(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const rawUrl = req.raw?.url || req.url || '';
    const prefix = '/api/files/r2/';
    const idx = rawUrl.indexOf(prefix);
    const rawKey =
      idx !== -1
        ? rawUrl.slice(idx + prefix.length).split('?')[0]
        : (req.params as any)?.['*'] || '';

    if (!rawKey) {
      return res.status(404).send({ message: 'Storage key is required' });
    }

    const key = decodeURIComponent(rawKey);

    let output = null;
    try {
      output = await this.fileService.getR2Stream(key);
    } catch {
      try {
        output = await this.fileService.getR2Stream(rawKey);
      } catch {}
    }

    if (!output?.Body) {
      return res.status(404).send({ message: 'File not found in storage' });
    }

    if (output.ContentType) {
      res.header('Content-Type', output.ContentType);
    }
    if (output.ContentLength) {
      res.header('Content-Length', output.ContentLength);
    }
    res.header('Cache-Control', 'public, max-age=31536000, immutable');

    return res.send(output.Body);
  }

  // ── Workspace Scoped ────────────────────────────────────────────────────────

  @Post('workspace/:workspaceId/upload')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  async uploadWorkspaceFile(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UploadFileDto,
  ) {
    return this.fileService.upload(
      userId,
      { workspaceId: currentWorkspaceId || workspaceId },
      dto,
    );
  }

  @Post('workspace/:workspaceId/folder')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  async createWorkspaceFolder(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFolderDto,
  ) {
    return this.fileService.createFolder(
      userId,
      { workspaceId: currentWorkspaceId || workspaceId },
      dto,
    );
  }

  @Get('workspace/:workspaceId/home')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getWorkspaceHome(@Param('workspaceId') workspaceId: string) {
    return this.fileService.getHomeFiles(workspaceId);
  }

  @Get('workspace/:workspaceId/all')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getWorkspaceAll(
    @Param('workspaceId') workspaceId: string,
    @Query('parentId') parentId?: string,
  ) {
    return this.fileService.getFiles({ workspaceId, parentId });
  }

  @Get('workspace/:workspaceId/my-files')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getWorkspaceMyFiles(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getMyFiles(userId, workspaceId);
  }

  @Get('workspace/:workspaceId/starred')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getWorkspaceStarred(@Param('workspaceId') workspaceId: string) {
    return this.fileService.getStarredFiles(workspaceId);
  }

  @Get('workspace/:workspaceId/shared')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getWorkspaceShared(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getSharedFiles(userId, workspaceId);
  }

  @Get('workspace/:workspaceId/trash')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getWorkspaceTrash(@Param('workspaceId') workspaceId: string) {
    return this.fileService.getTrashedFiles(workspaceId);
  }

  @Get('folder/:folderId/path')
  async getFolderPath(@Param('folderId') folderId: string) {
    return this.fileService.getFolderPath(folderId);
  }

  @Get('workspace/:workspaceId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getWorkspaceFiles(
    @Param('workspaceId') workspaceId: string,
    @Query('parentId') parentId?: string,
  ) {
    return this.fileService.getFiles({ workspaceId, parentId });
  }

  // ── Project Scoped ──────────────────────────────────────────────────────────

  @Post('project/:projectId/upload')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  async uploadProjectFile(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UploadFileDto,
  ) {
    return this.fileService.upload(userId, { projectId }, dto);
  }

  @Post('project/:projectId/folder')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  async createProjectFolder(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFolderDto,
  ) {
    return this.fileService.createFolder(userId, { projectId }, dto);
  }

  @Get('project/:projectId/my-files')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  async getProjectMyFiles(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getMyFiles(userId, undefined, projectId);
  }

  @Get('project/:projectId/starred')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  async getProjectStarred(@Param('projectId') projectId: string) {
    return this.fileService.getStarredFiles(undefined, projectId);
  }

  @Get('project/:projectId/shared')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  async getProjectShared(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getSharedFiles(userId, undefined, projectId);
  }

  @Get('project/:projectId/trash')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  async getProjectTrash(@Param('projectId') projectId: string) {
    return this.fileService.getTrashedFiles(undefined, projectId);
  }

  @Get('project/:projectId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  async getProjectFiles(
    @Param('projectId') projectId: string,
    @Query('parentId') parentId?: string,
  ) {
    return this.fileService.getFiles({ projectId, parentId });
  }

  // ── Page Scoped ────────────────────────────────────────────────────────────

  @Post('page/:pageId/upload')
  @HttpCode(HttpStatus.CREATED)
  async uploadPageFile(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UploadFileDto,
  ) {
    return this.fileService.upload(userId, { pageId }, dto);
  }

  @Post('page/:pageId/folder')
  @HttpCode(HttpStatus.CREATED)
  async createPageFolder(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFolderDto,
  ) {
    return this.fileService.createFolder(userId, { pageId }, dto);
  }

  @Get('page/:pageId')
  async getPageFiles(
    @Param('pageId') pageId: string,
    @Query('parentId') parentId?: string,
  ) {
    return this.fileService.getFiles({ pageId, parentId });
  }

  // ── General File Operations ────────────────────────────────────────────────

  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  async uploadGeneralFile(
    @CurrentUser('id') userId: string,
    @Body() dto: UploadFileDto,
  ) {
    return this.fileService.upload(
      userId,
      {
        workspaceId: dto.workspaceId,
        projectId: dto.projectId,
        pageId: dto.pageId,
      },
      dto,
    );
  }

  @Post('folder')
  @HttpCode(HttpStatus.CREATED)
  async createGeneralFolder(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFolderDto,
  ) {
    return this.fileService.createFolder(
      userId,
      {
        workspaceId: dto.workspaceId,
        projectId: dto.projectId,
        pageId: dto.pageId,
      },
      dto,
    );
  }

  // ── Batch Operations ──────────────────────────────────────────────────────

  @Post('batch/delete')
  @HttpCode(HttpStatus.OK)
  async batchDelete(@Body() dto: BatchFileIdsDto) {
    return this.fileService.batchDeleteFiles(dto.ids);
  }

  @Post('batch/restore')
  @HttpCode(HttpStatus.OK)
  async batchRestore(@Body() dto: BatchFileIdsDto) {
    return this.fileService.batchRestoreFiles(dto.ids);
  }

  @Post('batch/permanent-delete')
  @HttpCode(HttpStatus.OK)
  async batchPermanentDelete(@Body() dto: BatchFileIdsDto) {
    return this.fileService.batchPermanentlyDeleteFiles(dto.ids);
  }

  @Post('batch/star')
  @HttpCode(HttpStatus.OK)
  async batchStar(@Body() dto: BatchStarDto) {
    return this.fileService.batchToggleStar(dto.ids, dto.starred);
  }

  @Get(':fileId')
  async getFile(@Param('fileId') fileId: string) {
    return this.fileService.getFile(fileId);
  }

  @Put(':fileId')
  async updateFile(
    @Param('fileId') fileId: string,
    @Body() dto: UpdateFileDto,
  ) {
    return this.fileService.updateFile(fileId, dto);
  }

  @Delete(':fileId')
  async deleteFile(@Param('fileId') fileId: string) {
    return this.fileService.deleteFile(fileId);
  }

  @Put(':fileId/star')
  async toggleStar(@Param('fileId') fileId: string) {
    return this.fileService.toggleStar(fileId);
  }

  @Put(':fileId/restore')
  async restoreFile(@Param('fileId') fileId: string) {
    return this.fileService.restoreFile(fileId);
  }

  @Delete(':fileId/permanent')
  async permanentlyDeleteFile(@Param('fileId') fileId: string) {
    return this.fileService.permanentlyDeleteFile(fileId);
  }

  @Put(':fileId/rename')
  async renameFile(
    @Param('fileId') fileId: string,
    @Body() dto: RenameFileDto,
  ) {
    return this.fileService.renameFile(
      fileId,
      dto.filename || dto.name || 'Untitled',
    );
  }

  @Put(':fileId/move')
  async moveFile(@Param('fileId') fileId: string, @Body() dto: MoveFileDto) {
    return this.fileService.moveFile(fileId, dto.parentId);
  }

  @Put(':fileId/share')
  async shareFile(@Param('fileId') fileId: string, @Body() dto: ShareFileDto) {
    return this.fileService.shareFile(fileId, dto);
  }
}
