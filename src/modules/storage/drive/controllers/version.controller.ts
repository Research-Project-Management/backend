import {
  Controller,
  Get,
  Post,
  Param,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { FastifyRequest, FastifyReply } from 'fastify';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';
import { VersionService } from '@/modules/storage/drive';

@ApiTags('Storage File Versions')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/storage/files')
@UseGuards(JwtAuthGuard)
export class VersionController {
  constructor(private readonly versionService: VersionService) {}

  @Get(':fileId/versions')
  @ApiOperation({
    summary: 'Get all historical versions and revisions of a file',
  })
  async getVersions(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.versionService.listVersions(fileId, userId);
  }

  @Post(':fileId/versions')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Upload a new revision/version for an existing file',
  })
  async uploadVersion(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
  ) {
    const isMultipart =
      typeof req.isMultipart === 'function' ? req.isMultipart() : false;

    if (!isMultipart) {
      throw new BadRequestException('Request must be multipart/form-data');
    }

    const data = await req.file?.();
    if (!data) {
      throw new BadRequestException('No file uploaded');
    }

    const buffer = await data.toBuffer();
    const filename = data.filename || 'updated-file';
    const mimeType = data.mimetype || 'application/octet-stream';
    const fields = (data.fields || {}) as Record<
      string,
      { value?: string } | undefined
    >;
    const changeComment =
      fields.changeComment?.value ||
      fields.comment?.value ||
      fields.description?.value ||
      undefined;

    return this.versionService.uploadVersion({
      fileId,
      userId,
      buffer,
      filename,
      mimeType,
      changeComment,
    });
  }

  @Get(':fileId/versions/:versionNumber/download')
  @ApiOperation({
    summary: 'Download a specific historical version binary snapshot',
  })
  async downloadVersion(
    @Param('fileId') fileId: string,
    @Param('versionNumber', ParseIntPipe) versionNumber: number,
    @CurrentUser('id') userId: string,
    @Res() res: FastifyReply,
  ) {
    const result = await this.versionService.downloadVersion(
      fileId,
      versionNumber,
      userId,
    );

    res.header('Content-Type', result.mimeType);
    res.header('Content-Length', result.size);
    res.header('X-Content-Type-Options', 'nosniff');
    res.header(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(result.filename)}"`,
    );

    return res.send(result.stream);
  }

  @Post(':fileId/versions/:versionNumber/revert')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revert active file content to a specific historical version',
  })
  async revertVersion(
    @Param('fileId') fileId: string,
    @Param('versionNumber', ParseIntPipe) versionNumber: number,
    @CurrentUser('id') userId: string,
  ) {
    return this.versionService.revertVersion(fileId, versionNumber, userId);
  }
}
