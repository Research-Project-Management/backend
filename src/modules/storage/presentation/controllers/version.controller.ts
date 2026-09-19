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
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { UploadNewVersionUseCase } from '../../application/use-cases/version/upload-new-version.use-case';
import { GetFileVersionsUseCase } from '../../application/use-cases/version/get-file-versions.use-case';
import { DownloadFileVersionUseCase } from '../../application/use-cases/version/download-file-version.use-case';
import { RevertFileVersionUseCase } from '../../application/use-cases/version/revert-file-version.use-case';

@ApiTags('Storage File Versions')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/storage/files', 'api/files', 'api/file'])
@UseGuards(JwtAuthGuard)
export class VersionController {
  constructor(
    private readonly uploadNewVersionUseCase: UploadNewVersionUseCase,
    private readonly getFileVersionsUseCase: GetFileVersionsUseCase,
    private readonly downloadFileVersionUseCase: DownloadFileVersionUseCase,
    private readonly revertFileVersionUseCase: RevertFileVersionUseCase,
  ) {}

  @Get(':fileId/versions')
  @ApiOperation({
    summary: 'Get all historical versions and revisions of a file',
  })
  async getVersions(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.getFileVersionsUseCase.execute(fileId, userId);
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
      typeof (req as any).isMultipart === 'function'
        ? (req as any).isMultipart()
        : false;

    if (!isMultipart) {
      throw new BadRequestException('Request must be multipart/form-data');
    }

    const data = await (req as any).file();
    if (!data) {
      throw new BadRequestException('No file uploaded');
    }

    const buffer = await data.toBuffer();
    const filename = data.filename || 'updated-file';
    const mimeType = data.mimetype || 'application/octet-stream';
    const fields = data.fields || {};
    const changeComment =
      fields.changeComment?.value ||
      fields.comment?.value ||
      fields.description?.value ||
      undefined;

    return this.uploadNewVersionUseCase.execute({
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
    const result = await this.downloadFileVersionUseCase.execute(
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
    return this.revertFileVersionUseCase.execute(fileId, versionNumber, userId);
  }
}
