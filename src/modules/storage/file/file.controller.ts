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
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
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
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { Public } from '@/modules/iam/authn/decorators/public.decorator';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';

import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';
import { CurrentWorkspace } from '@/modules/iam/authz/decorators/current-workspace.decorator';

@ApiTags('Storage & Assets')
@ApiBearerAuth('JWT-auth')
@Controller('api/files')
@UseGuards(JwtAuthGuard)
export class FileController {
  constructor(private readonly fileService: FileService) {}

  @Post('presign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate presigned URL for direct client upload' })
  async presign(@Body() dto: PresignDto) {
    return this.fileService.presign(dto);
  }

  /**
   * Multipart Upload endpoint streaming directly to Cloudflare R2 / S3.
   */
  @Post('upload-r2')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Multipart stream upload directly to R2/S3' })
  async uploadR2(
    @Req() req: FastifyRequest,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.uploadMultipartStream(req, userId);
  }

  /**
   * Serve / Stream R2 File by storage key (Public for browser media & PDF viewers)
   */
  @Public()
  @Get('r2/*')
  @ApiOperation({ summary: 'Stream R2 stored file by storage key' })
  async getR2File(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
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
      } catch {
        // Fallback failed, handled by 404 check below
      }
    }

    if (!output?.Body) {
      return res.status(404).send({ message: 'File not found in storage' });
    }

    let contentType = output.ContentType || 'application/octet-stream';
    if (contentType === 'application/octet-stream') {
      const lower = key.toLowerCase();
      if (lower.endsWith('.pdf')) contentType = 'application/pdf';
      else if (lower.endsWith('.png')) contentType = 'image/png';
      else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg'))
        contentType = 'image/jpeg';
      else if (lower.endsWith('.svg')) contentType = 'image/svg+xml';
      else if (lower.endsWith('.webp')) contentType = 'image/webp';
      else if (lower.endsWith('.gif')) contentType = 'image/gif';
      else if (lower.endsWith('.mp4')) contentType = 'video/mp4';
      else if (lower.endsWith('.mp3')) contentType = 'audio/mpeg';
      else if (lower.endsWith('.json')) contentType = 'application/json';
      else if (lower.endsWith('.txt')) contentType = 'text/plain';
    }

    res.header('Content-Type', contentType);
    if (output.ContentLength) {
      res.header('Content-Length', output.ContentLength);
    }
    res.header('Cache-Control', 'public, max-age=31536000, immutable');

    // Attach stream error safety to prevent uncaught error events if client closes connection early
    const streamBody = output.Body as {
      on?: (event: string, listener: (...args: any[]) => void) => void;
    };
    if (typeof streamBody?.on === 'function') {
      streamBody.on('error', () => {
        // Suppress stream error when client disconnects early
      });
    }

    return res.send(output.Body);
  }

  // ── Workspace Scoped ────────────────────────────────────────────────────────

  @Post('workspace/:workspaceId/upload')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Upload file to workspace storage' })
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
  @ApiOperation({ summary: 'Create folder in workspace' })
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
  @ApiOperation({ summary: 'Get workspace home/root files' })
  async getWorkspaceHome(@Param('workspaceId') workspaceId: string) {
    return this.fileService.getHomeFiles(workspaceId);
  }

  @Get('workspace/:workspaceId/all')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary: 'List all workspace files with optional parent filter',
  })
  async getWorkspaceAll(
    @Param('workspaceId') workspaceId: string,
    @Query('parentId') parentId?: string,
  ) {
    return this.fileService.getFiles({ workspaceId, parentId });
  }

  @Get('workspace/:workspaceId/my-files')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get files uploaded by current user in workspace' })
  async getWorkspaceMyFiles(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getMyFiles(userId, workspaceId);
  }

  @Get('workspace/:workspaceId/starred')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get starred files in workspace' })
  async getWorkspaceStarred(@Param('workspaceId') workspaceId: string) {
    return this.fileService.getStarredFiles(workspaceId);
  }

  @Get('workspace/:workspaceId/shared')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get files shared with current user in workspace' })
  async getWorkspaceShared(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getSharedFiles(userId, workspaceId);
  }

  @Get('workspace/:workspaceId/trash')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get trashed files in workspace' })
  async getWorkspaceTrash(@Param('workspaceId') workspaceId: string) {
    return this.fileService.getTrashedFiles(workspaceId);
  }

  @Get('folder/:folderId/path')
  async getFolderPath(@Param('folderId') folderId: string) {
    return this.fileService.getFolderPath(folderId);
  }

  @Get('workspace/:workspaceId/usage')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get workspace storage usage' })
  async getWorkspaceStorageUsage(@Param('workspaceId') workspaceId: string) {
    return this.fileService.getStorageUsage(workspaceId);
  }

  @Get('workspace/:workspaceId/stats')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get workspace storage stats (alias)' })
  async getWorkspaceStorageStats(@Param('workspaceId') workspaceId: string) {
    return this.fileService.getStorageUsage(workspaceId);
  }

  @Get('workspace/:workspaceId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'List workspace files by parent folder' })
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
  @ApiOperation({ summary: 'Upload file to project storage' })
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
  @ApiOperation({ summary: 'Create folder in project' })
  async createProjectFolder(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFolderDto,
  ) {
    return this.fileService.createFolder(userId, { projectId }, dto);
  }

  @Get('project/:projectId/my-files')
  @ApiOperation({ summary: 'Get files uploaded by current user in project' })
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  async getProjectMyFiles(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getMyFiles(userId, undefined, projectId);
  }

  @Get('project/:projectId/starred')
  @ApiOperation({ summary: 'Get starred files in project' })
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  async getProjectStarred(@Param('projectId') projectId: string) {
    return this.fileService.getStarredFiles(undefined, projectId);
  }

  @Get('project/:projectId/shared')
  @ApiOperation({ summary: 'Get files shared with current user in project' })
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  async getProjectShared(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getSharedFiles(userId, undefined, projectId);
  }

  @Get('project/:projectId/trash')
  @ApiOperation({ summary: 'Get trashed files in project' })
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  async getProjectTrash(@Param('projectId') projectId: string) {
    return this.fileService.getTrashedFiles(undefined, projectId);
  }

  @Get('project/:projectId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'List project files' })
  async getProjectFiles(
    @Param('projectId') projectId: string,
    @Query('parentId') parentId?: string,
  ) {
    return this.fileService.getFiles({ projectId, parentId });
  }

  // ── Page Scoped ────────────────────────────────────────────────────────────

  @Post('page/:pageId/upload')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Upload file attached to a page' })
  async uploadPageFile(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UploadFileDto,
  ) {
    return this.fileService.upload(userId, { pageId }, dto);
  }

  @Post('page/:pageId/folder')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create folder in page' })
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  async createPageFolder(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFolderDto,
  ) {
    return this.fileService.createFolder(userId, { pageId }, dto);
  }

  @Get('page/:pageId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'List files attached to a page' })
  async getPageFiles(
    @Param('pageId') pageId: string,
    @Query('parentId') parentId?: string,
  ) {
    return this.fileService.getFiles({ pageId, parentId });
  }

  // ── General File Operations ────────────────────────────────────────────────

  @ApiOperation({ summary: 'Upload a general file (workspace-level)' })
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

  @ApiOperation({ summary: 'Create a general folder' })
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

  @Get(':fileId/content')
  @ApiOperation({ summary: 'Stream binary content of file' })
  async getFileContent(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const rangeHeader = req.headers?.range;

    try {
      const {
        stream,
        contentType,
        contentLength,
        contentRange,
        filename,
        statusCode,
      } = await this.fileService.getFileContentStream(
        fileId,
        userId,
        rangeHeader,
      );

      res.status(
        statusCode ||
          (contentRange ? HttpStatus.PARTIAL_CONTENT : HttpStatus.OK),
      );
      res.header('Content-Type', contentType);
      if (contentLength !== undefined && contentLength !== null) {
        res.header('Content-Length', contentLength);
      }
      if (contentRange) {
        res.header('Content-Range', contentRange);
      }
      res.header('Accept-Ranges', 'bytes');
      res.header('X-Content-Type-Options', 'nosniff');
      res.header('Cache-Control', 'private, no-cache, no-transform');

      // Safe inline policy: only PDF and safe image MIME types are permitted to be rendered inline
      const safeInlineTypes = new Set([
        'application/pdf',
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
      ]);
      const isInline = safeInlineTypes.has(contentType);
      const dispositionType = isInline ? 'inline' : 'attachment';

      // Sanitize filename against CRLF / Header injection
      const sanitizedFilename = (filename || 'file').replace(/[\r\n\t"]/g, '_');
      const encodedFilename = encodeURIComponent(sanitizedFilename);

      res.header(
        'Content-Disposition',
        `${dispositionType}; filename="${sanitizedFilename}"; filename*=UTF-8''${encodedFilename}`,
      );

      const streamBody = stream as {
        on?: (event: string, listener: (...args: any[]) => void) => void;
      };
      if (typeof streamBody?.on === 'function') {
        streamBody.on('error', () => {
          // Suppress stream error when client disconnects/aborts early
        });
      }

      return res.send(stream);
    } catch (err: any) {
      if (
        err?.$metadata?.httpStatusCode === 416 ||
        err?.statusCode === 416 ||
        err?.status === 416 ||
        err?.response?.statusCode === 416
      ) {
        if (err?.response?.contentRange) {
          res.header('Content-Range', err.response.contentRange);
        }
        res.header('Accept-Ranges', 'bytes');
        return res
          .status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
          .send({ message: 'Requested range not satisfiable' });
      }
      throw err;
    }
  }

  @Get(':fileId')
  @ApiOperation({ summary: 'Get file metadata by ID' })
  async getFile(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getFile(fileId, userId);
  }

  @Put([':fileId', ':fileId/metadata'])
  @ApiOperation({ summary: 'Update file metadata' })
  async updateFile(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateFileDto,
  ) {
    return this.fileService.updateFile(fileId, userId, dto);
  }

  @Delete(':fileId')
  @ApiOperation({ summary: 'Move file to trash' })
  async deleteFile(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.deleteFile(fileId, userId);
  }
  @ApiOperation({ summary: 'Toggle star on file (alias)' })
  @Put(':fileId/star')
  async toggleStar(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.toggleStar(fileId, userId);
  }

  @Put(':fileId/restore')
  @ApiOperation({ summary: 'Restore file from trash' })
  async restoreFile(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.restoreFile(fileId, userId);
  }

  @Delete(':fileId/permanent')
  @ApiOperation({ summary: 'Permanently delete file from storage' })
  async permanentlyDeleteFile(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.permanentlyDeleteFile(fileId, userId);
  }

  @Put(':fileId/rename')
  @ApiOperation({ summary: 'Rename a file or folder' })
  async renameFile(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: RenameFileDto,
  ) {
    return this.fileService.renameFile(
      fileId,
      userId,
      dto.filename || dto.name || 'Untitled',
    );
  }

  @Put(':fileId/move')
  @ApiOperation({ summary: 'Move file to a different folder' })
  async moveFile(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: MoveFileDto,
  ) {
    return this.fileService.moveFile(fileId, userId, dto.parentId);
  }

  @Put(':fileId/share')
  @ApiOperation({ summary: 'Share file with a workspace member' })
  async shareFile(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ShareFileDto,
  ) {
    return this.fileService.shareFile(fileId, userId, dto);
  }

  @Get(':fileId/share')
  @ApiOperation({ summary: 'Get share settings and permissions for a file' })
  async getShareSettings(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getShareSettings(fileId, userId);
  }
}
