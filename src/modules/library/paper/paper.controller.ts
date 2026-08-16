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
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PaperService } from './paper.service';
import {
  IngestPaperDto,
  UploadPaperDto,
  AddAttachmentDto,
  UpdatePaperDto,
  ImportStoragePaperDto,
} from './dto/paper.dto';
import { JwtAuthGuard } from '@/modules/iam/authentication';
import { CurrentUser } from '@/modules/iam/authentication';

@ApiTags('Library')
@ApiBearerAuth('JWT-auth')
@Controller('api/library')
@UseGuards(JwtAuthGuard)
export class PaperController {
  constructor(private readonly paperService: PaperService) {}

  @Post(['papers/:workspaceId/ingest', ':workspaceId/ingest'])
  @HttpCode(HttpStatus.CREATED)
  async ingestPaper(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: IngestPaperDto,
  ) {
    return this.paperService.ingestPaper(workspaceId, userId, dto);
  }

  @Get(['papers/:workspaceId', ':workspaceId/papers'])
  async getPapers(
    @Param('workspaceId') workspaceId: string,
    @Query('collectionId') collectionId?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: number,
    @Query('skip') skip?: number,
  ) {
    return this.paperService.getPapers(workspaceId, {
      collectionId,
      search,
      limit,
      skip,
    });
  }

  @Get(':workspaceId/collections/:collectionId/papers')
  async getCollectionPapers(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
    @Query('search') search?: string,
  ) {
    return this.paperService.getPapers(workspaceId, {
      collectionId,
      search,
    });
  }

  @Post([
    'papers/:workspaceId/upload',
    ':workspaceId/papers/upload',
    ':workspaceId/upload',
  ])
  @HttpCode(HttpStatus.CREATED)
  async uploadPaper(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UploadPaperDto,
  ) {
    return this.paperService.uploadPaper(workspaceId, userId, dto);
  }

  @Post(':workspaceId/collections/:collectionId/papers')
  @HttpCode(HttpStatus.CREATED)
  async uploadPaperToCollection(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UploadPaperDto,
  ) {
    dto.collectionId = collectionId;
    return this.paperService.uploadPaper(workspaceId, userId, dto);
  }

  @Post([
    'papers/:workspaceId/import-storage',
    ':workspaceId/papers/import-storage',
    ':workspaceId/import-storage',
  ])
  @HttpCode(HttpStatus.CREATED)
  async importFromStorage(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ImportStoragePaperDto,
  ) {
    return this.paperService.importFromStorage(workspaceId, userId, dto);
  }

  @Get(['papers/:workspaceId/:paperId', ':workspaceId/:paperId'])
  async getPaperById(@Param('paperId') paperId: string) {
    return this.paperService.getPaperById(paperId);
  }

  @Post([
    'papers/:workspaceId/:paperId/attachments',
    ':workspaceId/papers/:paperId/attachments',
    ':workspaceId/:paperId/attachments',
  ])
  @HttpCode(HttpStatus.CREATED)
  async addAttachment(
    @Param('paperId') paperId: string,
    @Body() dto: AddAttachmentDto,
  ) {
    return this.paperService.addAttachment(paperId, dto);
  }

  @Delete([
    'papers/:workspaceId/:paperId/attachments/:attachmentId',
    ':workspaceId/papers/:paperId/attachments/:attachmentId',
    ':workspaceId/:paperId/attachments/:attachmentId',
  ])
  async removeAttachment(
    @Param('paperId') paperId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.paperService.removeAttachment(paperId, attachmentId);
  }

  @Post([
    'papers/:workspaceId/:paperId/reindex',
    ':workspaceId/papers/:paperId/reindex',
    ':workspaceId/:paperId/reindex',
  ])
  @HttpCode(HttpStatus.OK)
  async triggerReindex(
    @Param('paperId') paperId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.paperService.triggerReindex(paperId, userId);
  }

  @Put([
    'papers/:workspaceId/:paperId',
    ':workspaceId/papers/:paperId',
    ':workspaceId/:paperId',
  ])
  async updatePaper(
    @Param('paperId') paperId: string,
    @Body() dto: UpdatePaperDto,
  ) {
    return this.paperService.updatePaper(paperId, dto);
  }

  @Delete([
    'papers/:workspaceId/:paperId',
    ':workspaceId/papers/:paperId',
    ':workspaceId/:paperId',
  ])
  async deletePaper(@Param('paperId') paperId: string) {
    return this.paperService.deletePaper(paperId);
  }

  @Get('papers/:workspaceId/:paperId/bibtex')
  async exportBibtex(@Param('paperId') paperId: string) {
    return this.paperService.exportBibtex(paperId);
  }
}
