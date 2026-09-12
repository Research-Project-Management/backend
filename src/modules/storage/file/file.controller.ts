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
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { Public } from '@/modules/iam/authn/decorators/public.decorator';
@ApiTags('Storage & Assets')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/storage/files', 'api/files', 'api/file'])
@UseGuards(JwtAuthGuard)
export class FileController {
  constructor(private readonly fileService: FileService) {}

  @Post('presign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate presigned URL for direct client upload' })
  async presign(@CurrentUser('id') userId: string, @Body() dto: PresignDto) {
    return this.fileService.presign(userId, dto);
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
   * Serve / Stream R2 File by storage key (Requires authentication and file access)
   */
  @Get('r2/*')
  @ApiOperation({ summary: 'Stream R2 stored file by storage key' })
  async getR2File(
    @CurrentUser('id') userId: string,
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

    const file = await this.fileService.findFileByKey(key);
    if (!file) {
      return res.status(404).send({ message: 'File not found in storage' });
    }
    await this.fileService.assertCanAccessFile(userId, file.id, 'read');

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
    this.setDownloadHeaders(res, contentType, file.filename || 'file');

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

  // ── Top-Level Storage Operations (User / Highest Scope) ────────────────────

  @Get(['my-files', 'me/files', 'me'])
  @ApiOperation({ summary: 'Get current user personal files' })
  async getMyPersonalFiles(@CurrentUser('id') userId: string) {
    return this.fileService.getMyFiles(userId);
  }

  @Get(['starred', 'me/starred'])
  @ApiOperation({ summary: 'Get current user starred files' })
  async getStarredFiles(@CurrentUser('id') userId: string) {
    return this.fileService.getStarredFiles(userId);
  }

  @Get(['shared', 'me/shared'])
  @ApiOperation({ summary: 'Get current user shared files' })
  async getSharedFiles(@CurrentUser('id') userId: string) {
    return this.fileService.getSharedFiles(userId);
  }

  @Get(['trash', 'me/trash'])
  @ApiOperation({ summary: 'Get current user trashed files' })
  async getTrashedFiles(@CurrentUser('id') userId: string) {
    return this.fileService.getTrashedFiles(userId);
  }

  @Get(['usage', 'me/usage'])
  @ApiOperation({ summary: 'Get current user or project storage usage' })
  async getStorageUsage(
    @CurrentUser('id') userId: string,
    @Query('projectId') projectId?: string,
  ) {
    if (projectId) {
      return this.fileService.getProjectStorageUsage(projectId, userId);
    }
    return this.fileService.getUserStorageUsage(userId);
  }

  @Get(['projects/:projectId/usage', 'project/:projectId/usage'])
  @ApiOperation({ summary: 'Get project storage usage (charged to project owner)' })
  async getProjectUsage(
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.fileService.getProjectStorageUsage(projectId, userId);
  }

  @Get('')
  @ApiOperation({ summary: 'List user files by parent folder' })
  async getFiles(
    @CurrentUser('id') userId: string,
    @Query('parentId') parentId?: string,
  ) {
    return this.fileService.getFiles({ userId, parentId });
  }

  @Get('folder/:folderId/path')
  @ApiOperation({ summary: 'Get folder hierarchy path' })
  async getFolderPath(
    @Param('folderId') folderId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getFolderPath(folderId, userId);
  }

  // ── Page Scoped ────────────────────────────────────────────────────────────

  @Post(['pages/:pageId/upload', 'page/:pageId/upload'])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Upload file attached to a page' })
  async uploadPageFile(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UploadFileDto,
  ) {
    return this.fileService.upload(userId, { pageId }, dto);
  }

  @Post(['pages/:pageId/folder', 'page/:pageId/folder'])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create folder in page' })
  async createPageFolder(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFolderDto,
  ) {
    return this.fileService.createFolder(userId, { pageId }, dto);
  }

  @Get(['pages/:pageId', 'page/:pageId'])
  @ApiOperation({ summary: 'List files attached to a page' })
  async getPageFiles(
    @Param('pageId') pageId: string,
    @Query('parentId') parentId?: string,
  ) {
    return this.fileService.getFiles({ pageId, parentId });
  }

  // ── General File Operations ────────────────────────────────────────────────

  @ApiOperation({ summary: 'Upload a general file' })
  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  async uploadGeneralFile(
    @CurrentUser('id') userId: string,
    @Body() dto: UploadFileDto,
  ) {
    return this.fileService.upload(
      userId,
      {
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
        pageId: dto.pageId,
      },
      dto,
    );
  }

  // ── Batch Operations ──────────────────────────────────────────────────────

  @Post('batch/delete')
  @HttpCode(HttpStatus.OK)
  async batchDelete(
    @CurrentUser('id') userId: string,
    @Body() dto: BatchFileIdsDto,
  ) {
    return this.fileService.batchDeleteFiles(dto.ids, userId);
  }

  @Post('batch/restore')
  @HttpCode(HttpStatus.OK)
  async batchRestore(
    @CurrentUser('id') userId: string,
    @Body() dto: BatchFileIdsDto,
  ) {
    return this.fileService.batchRestoreFiles(dto.ids, userId);
  }

  @Post('batch/permanent-delete')
  @HttpCode(HttpStatus.OK)
  async batchPermanentDelete(
    @CurrentUser('id') userId: string,
    @Body() dto: BatchFileIdsDto,
  ) {
    return this.fileService.batchPermanentlyDeleteFiles(dto.ids, userId);
  }

  @Post('batch/star')
  @HttpCode(HttpStatus.OK)
  async batchStar(
    @CurrentUser('id') userId: string,
    @Body() dto: BatchStarDto,
  ) {
    return this.fileService.batchToggleStar(dto.ids, dto.starred, userId);
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
      this.setDownloadHeaders(res, contentType, filename || 'file');

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
  @ApiOperation({ summary: 'Share file with a project member or user' })
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

  private setDownloadHeaders(
    res: FastifyReply,
    contentType: string,
    filename: string,
  ): void {
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('Cache-Control', 'private, no-cache, no-transform');

    const safeInlineTypes = new Set([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
    ]);
    const isInline = safeInlineTypes.has(contentType);
    const dispositionType = isInline ? 'inline' : 'attachment';

    if (contentType === 'image/svg+xml' || contentType === 'text/html') {
      res.header('Content-Security-Policy', "default-src 'none'; sandbox");
    }

    const sanitizedFilename = (filename || 'file').replace(/[\r\n\t"]/g, '_');
    const encodedFilename = encodeURIComponent(sanitizedFilename);
    res.header(
      'Content-Disposition',
      `${dispositionType}; filename="${sanitizedFilename}"; filename*=UTF-8''${encodedFilename}`,
    );
  }
}
