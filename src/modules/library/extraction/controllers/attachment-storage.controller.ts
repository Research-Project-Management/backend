import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  Inject,
  ParseUUIDPipe,
} from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import { AttachmentsService } from '@/modules/library/extraction/services/attachments.service';
import {
  PresignUploadDto,
  CompletePresignDto,
  InitiateMultipartDto,
  CompleteMultipartDto,
  SAFE_ATTACHMENT_URL_REGEX,
} from '@/modules/library/extraction/dto/attachments.dto';
import { MAX_SAFE_HTTP_PAYLOAD_BYTES } from '@/modules/library/core';

/**
 * Unified Library Storage Controller (`/api/v1/library` and `/api/v1/projects/:projectId/library`).
 * Enforces JwtAuthGuard and ProjectAccessGuard.
 */
@ApiTags('Library Attachments - Storage Gateway')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/library', 'api/v1/projects/:projectId/library'])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class AttachmentStorageController {
  constructor(
    @Inject(STORAGE_PORT)
    private readonly storagePort: IStoragePort,
    private readonly attachmentsService: AttachmentsService,
  ) {}

  @Post('upload')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Upload a binary file directly via multipart stream to library',
  })
  async uploadLibraryFile(
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const projectId = paramProjectId || queryProjectId;
    if (!this.storagePort?.uploadFile) {
      throw new BadRequestException('Storage service is unavailable');
    }

    let buffer: Buffer | undefined;
    let filename = 'document.pdf';
    let mimeType = 'application/pdf';

    const multipartReq = req as FastifyRequest & {
      parts: () => AsyncIterable<{
        type: string;
        filename?: string;
        mimetype?: string;
        toBuffer: () => Promise<Buffer>;
      }>;
    };
    const parts = multipartReq.parts();
    for await (const part of parts) {
      if (part.type === 'file') {
        buffer = await part.toBuffer();
        if (buffer.length > MAX_SAFE_HTTP_PAYLOAD_BYTES) {
          throw new BadRequestException(
            `File size (${(buffer.length / (1024 * 1024)).toFixed(1)} MB) exceeds direct upload limit of ${MAX_SAFE_HTTP_PAYLOAD_BYTES / (1024 * 1024)} MB. Please use presigned S3 upload.`,
          );
        }
        filename = part.filename || filename;
        mimeType = part.mimetype || mimeType;
      }
    }

    if (!buffer) {
      throw new BadRequestException(
        'No binary file provided in multipart body',
      );
    }

    const uploadResult = await this.storagePort.uploadFile({
      userId,
      projectId,
      filename,
      mimeType,
      buffer,
      source: 'library',
    });

    return {
      success: true,
      ...uploadResult,
    };
  }

  @Post('attachments/presign')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Obtain presigned upload URL for direct S3 upload' })
  async presignUpload(
    @CurrentUser('id') userId: string,
    @Body() dto: PresignUploadDto,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (!this.storagePort?.getPresignedUploadUrl) {
      throw new BadRequestException('Direct presigned upload unavailable');
    }

    return this.storagePort.getPresignedUploadUrl({
      userId,
      projectId: paramProjectId || queryProjectId,
      filename: dto.filename,
      mimeType: dto.mimeType || 'application/octet-stream',
      sizeBytes: dto.sizeBytes || 0,
      scope: 'library',
      contentHash: dto.contentHash,
    });
  }

  @Post('attachments/presign/complete')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete and verify presigned S3 upload' })
  async completePresignedUpload(
    @CurrentUser('id') userId: string,
    @Body() dto: CompletePresignDto,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (!this.storagePort?.completePresignedUpload) {
      return { success: true, storageKey: dto.storageKey };
    }

    return this.storagePort.completePresignedUpload({
      storageKey: dto.storageKey,
      filename: dto.filename,
      mimeType: dto.mimeType,
      sizeBytes: dto.sizeBytes,
      contentHash: dto.contentHash,
      userId,
      projectId: paramProjectId || queryProjectId,
    });
  }

  @Post('attachments/multipart/initiate')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Initiate S3 multipart upload session' })
  async initiateMultipart(
    @CurrentUser('id') userId: string,
    @Body() dto: InitiateMultipartDto,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (!this.storagePort?.initiateMultipartUpload) {
      throw new BadRequestException('Multipart upload unavailable');
    }

    return this.storagePort.initiateMultipartUpload({
      userId,
      filename: dto.filename || 'document.bin',
      mimeType: dto.mimeType || 'application/octet-stream',
      totalSize: dto.totalSize,
      projectId: paramProjectId || queryProjectId,
      scope: 'library',
      expectedHash: dto.expectedHash,
    });
  }

  @Get('attachments/multipart/:sessionId/part-url')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get presigned URL for specific S3 multipart chunk',
  })
  async getMultipartPartUrl(
    @CurrentUser('id') userId: string,
    @Param('sessionId') sessionId: string,
    @Query('partNumber') partNumberStr: string,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (!this.storagePort?.getMultipartPartUrl) {
      throw new BadRequestException('Multipart part URL unavailable');
    }

    const partNumber = parseInt(partNumberStr, 10);
    if (isNaN(partNumber) || partNumber < 1) {
      throw new BadRequestException('Invalid partNumber query parameter');
    }

    const partUrl = await this.storagePort.getMultipartPartUrl(
      sessionId,
      partNumber,
      { userId, projectId: paramProjectId || queryProjectId },
    );
    return { partNumber, partUrl };
  }

  @Post('attachments/multipart/complete')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete S3 multipart upload session' })
  async completeMultipart(
    @CurrentUser('id') userId: string,
    @Body() dto: CompleteMultipartDto,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (!this.storagePort?.completeMultipartUpload) {
      throw new BadRequestException('Multipart completion unavailable');
    }

    return this.storagePort.completeMultipartUpload({
      sessionId: dto.sessionId,
      parts: dto.parts,
      actor: { userId, projectId: paramProjectId || queryProjectId },
    });
  }

  @Delete('attachments/multipart/:sessionId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Abort S3 multipart upload session' })
  async abortMultipart(
    @CurrentUser('id') userId: string,
    @Param('sessionId') sessionId: string,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (this.storagePort?.abortMultipartUpload) {
      await this.storagePort.abortMultipartUpload(sessionId, {
        userId,
        projectId: paramProjectId || queryProjectId,
      });
    }
    return { success: true };
  }

  @Get(['files/:fileId', 'files/:fileId/content'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Stream binary content directly by fileId' })
  async streamLibraryFile(
    @CurrentUser('id') userId: string,
    @Param('fileId') fileId: string,
    @Res() res: FastifyReply,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const projectId = paramProjectId || queryProjectId;
    if (!this.storagePort) {
      throw new NotFoundException('Storage port unavailable');
    }

    if (this.storagePort.getOwnedFileStream) {
      const fileRecord = await this.storagePort.getOwnedFileStream({
        fileId,
        userId,
        projectId,
      });

      return this.sendAttachmentPayload(res, {
        content: fileRecord.stream,
        filename: fileRecord.filename,
        size: fileRecord.size,
        mimeType: fileRecord.mimeType,
      });
    }

    if (this.storagePort.readOwnedFile) {
      const fileRecord = await this.storagePort.readOwnedFile({
        fileId,
        userId,
        projectId,
      });

      return this.sendAttachmentPayload(res, {
        content: fileRecord.buffer,
        filename: fileRecord.filename,
        size: fileRecord.size,
        mimeType: fileRecord.mimeType,
      });
    }

    throw new NotFoundException('Storage port read capability unavailable');
  }

  @Get('attachments/:attachmentId/presigned-url')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get direct S3 presigned URL for downloading attachment',
  })
  async getAttachmentPresignedUrl(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const projectId = paramProjectId || queryProjectId;
    const { attachment } = await this.attachmentsService.getItemAttachment(
      userId,
      undefined,
      attachmentId,
      projectId,
    );

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    if (attachment.fileId && this.storagePort?.getPresignedDownloadUrl) {
      const presignedUrl = await this.storagePort.getPresignedDownloadUrl(
        attachment.fileId,
        3600,
      );
      return {
        url: presignedUrl,
        expiresIn: 3600,
        filename: attachment.filename || 'attachment.pdf',
        mimeType: attachment.mimeType || 'application/pdf',
      };
    }

    if (attachment.url) {
      const trimmedUrl = attachment.url.trim();
      if (!SAFE_ATTACHMENT_URL_REGEX.test(trimmedUrl)) {
        throw new BadRequestException(
          'Unsafe or unsupported attachment redirect URL scheme',
        );
      }
      return {
        url: trimmedUrl,
        expiresIn: 3600,
        filename: attachment.filename || 'attachment.pdf',
        mimeType: attachment.mimeType || 'application/pdf',
      };
    }

    throw new BadRequestException(
      'Presigned download URL unavailable for this attachment',
    );
  }

  @Get([
    'attachments/:attachmentId/content',
    'items/:itemId/attachments/:attachmentId/content',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Stream attachment binary content with byte-range support',
  })
  async streamAttachmentContent(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const projectId = paramProjectId || queryProjectId;
    const { attachment } = await this.attachmentsService.getItemAttachment(
      userId,
      undefined,
      attachmentId,
      projectId,
    );

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    if (attachment.fileId && this.storagePort) {
      const defaultFilename = attachment.filename || 'attachment.pdf';
      const defaultMimeType = attachment.mimeType;

      const rangeHeader = req.headers.range;
      let range: { start: number; end: number } | undefined;
      if (
        rangeHeader &&
        typeof rangeHeader === 'string' &&
        /^bytes=\d+-\d*$/.test(rangeHeader)
      ) {
        const parts = rangeHeader.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : undefined;
        if (!isNaN(start)) {
          range = { start, end: end ?? -1 };
        }
      }

      if (this.storagePort.getOwnedFileStream) {
        const fileRecord = (await this.storagePort.getOwnedFileStream({
          fileId: attachment.fileId,
          userId,
          projectId,
          ...(range ? { range } : {}),
        })) as {
          stream: NodeJS.ReadableStream;
          mimeType: string;
          size: number;
          filename: string;
          contentRange?: string;
          isPartial?: boolean;
        };

        return this.sendAttachmentPayload(res, {
          content: fileRecord.stream,
          filename:
            attachment.filename || fileRecord.filename || defaultFilename,
          size: fileRecord.size,
          mimeType: fileRecord.mimeType || defaultMimeType,
          contentRange: fileRecord.contentRange,
          isPartial:
            fileRecord.isPartial ?? Boolean(fileRecord.contentRange),
        });
      }

      if (this.storagePort.readOwnedFile) {
        const fileRecord = await this.storagePort.readOwnedFile({
          fileId: attachment.fileId,
          userId,
          projectId,
        });

        let bufferContent = fileRecord.buffer;
        let contentRange: string | undefined;
        let isPartial = false;
        const totalSize = fileRecord.size || bufferContent.length;

        if (range && totalSize > 0) {
          const start = Math.max(0, Math.min(range.start, totalSize - 1));
          const end =
            range.end >= 0
              ? Math.min(range.end, totalSize - 1)
              : totalSize - 1;
          if (start <= end) {
            bufferContent = bufferContent.subarray(start, end + 1);
            contentRange = `bytes ${start}-${end}/${totalSize}`;
            isPartial = true;
          }
        }

        return this.sendAttachmentPayload(res, {
          content: bufferContent,
          filename:
            attachment.filename || fileRecord.filename || defaultFilename,
          size: isPartial ? bufferContent.length : totalSize,
          mimeType: fileRecord.mimeType || defaultMimeType,
          contentRange,
          isPartial,
        });
      }
    }

    if (attachment.url) {
      const trimmedUrl = attachment.url.trim();
      if (!SAFE_ATTACHMENT_URL_REGEX.test(trimmedUrl)) {
        throw new BadRequestException(
          'Unsafe or unsupported attachment redirect URL scheme',
        );
      }
      return res.redirect(trimmedUrl, 302);
    }

    throw new NotFoundException(
      'No content stream available for this attachment',
    );
  }

  private static readonly DANGEROUS_MIME_TYPES = new Set<string>([
    'text/html',
    'application/xhtml+xml',
    'image/svg+xml',
    'application/javascript',
    'text/javascript',
  ]);

  private sendAttachmentPayload(
    res: FastifyReply,
    payload: {
      content: Buffer | Uint8Array | NodeJS.ReadableStream | string;
      filename: string;
      size: number;
      mimeType?: string;
      contentRange?: string;
      isPartial?: boolean;
    },
  ) {
    const rawMimeType = (payload.mimeType || 'application/pdf').trim();
    const baseMimeType = rawMimeType.split(';')[0].trim().toLowerCase();
    const isDangerousMime =
      AttachmentStorageController.DANGEROUS_MIME_TYPES.has(baseMimeType);
    const dispositionType = isDangerousMime ? 'attachment' : 'inline';

    res.header('Content-Type', rawMimeType);
    res.header('X-Content-Type-Options', 'nosniff');
    res.header(
      'Content-Security-Policy',
      "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; sandbox",
    );
    res.header(
      'Content-Disposition',
      `${dispositionType}; filename="${encodeURIComponent(payload.filename)}"`,
    );
    res.header('Accept-Ranges', 'bytes');
    res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.header('Vary', 'Authorization, Range');

    let contentLength = payload.size;
    if (payload.isPartial || payload.contentRange) {
      res.status(206);
      if (payload.contentRange) {
        res.header('Content-Range', payload.contentRange);
        const rangeMatch = payload.contentRange.match(
          /^bytes\s+(\d+)-(\d+)\//i,
        );
        if (rangeMatch?.[1] !== undefined && rangeMatch?.[2] !== undefined) {
          const start = parseInt(rangeMatch[1], 10);
          const end = parseInt(rangeMatch[2], 10);
          if (!isNaN(start) && !isNaN(end) && end >= start) {
            contentLength = end - start + 1;
          }
        }
      }
    }

    res.header('Content-Length', contentLength);
    return res.send(payload.content);
  }
}
