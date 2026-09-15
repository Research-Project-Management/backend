import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/user.decorator';
import { ExportsService } from './exports.service';
import { ExportLibraryDto, ExportFormatType } from './dto/exports.dto';

@Controller('api/v1/library/exports')
@UseGuards(JwtAuthGuard)
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  @Get('items/:itemId/annotated-pdf')
  async exportAnnotatedPdf(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
  ) {
    const res = await this.exportsService.exportAnnotatedItemPdf(
      userId,
      itemId,
    );
    return {
      filename: res.filename,
      mimeType: 'application/pdf',
      base64: Buffer.from(res.buffer).toString('base64'),
    };
  }

  @Post()
  async exportLibrary(
    @CurrentUser('id') userId: string,
    @Body() dto: ExportLibraryDto,
  ) {
    return this.exportsService.exportLibrary(userId, dto);
  }

  @Post('citations/bibtex')
  async exportCitationsBibtex(
    @CurrentUser('id') userId: string,
    @Body() body: { keys: string[] },
  ) {
    return this.exportsService.exportByCitationKeys(userId, body.keys || []);
  }

  @Get()
  async exportLibraryGet(
    @CurrentUser('id') userId: string,
    @Query('format') format?: ExportFormatType,
    @Query('collectionId') collectionIdQuery?: string,
    @Query('tagId') tagId?: string,
    @Query('projectId') projectIdQuery?: string,
  ) {
    const effectiveFormat = format || 'bibtex';
    const result = await this.exportsService.exportLibrary(userId, {
      format: effectiveFormat,
      collectionId: collectionIdQuery,
      tagId,
      projectId: projectIdQuery,
    });

    return {
      ...result,
      bibtex: result.content,
      total: result.itemCount,
      filename: result.filename,
    };
  }

  @Get(':collectionId/export-bundle')
  async getCollectionBundle(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
  ) {
    return this.exportsService.exportBundle(userId, collectionId);
  }
}
