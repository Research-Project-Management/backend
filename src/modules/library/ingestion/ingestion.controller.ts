import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IngestionService } from './ingestion.service';
import { IngestDocumentDto, BatchIngestDto } from './dto/ingestion.dto';
import { JwtAuthGuard } from '@/modules/iam/authentication';
import { CurrentUser } from '@/modules/iam/authentication';

@ApiTags('Library - Ingestion')
@ApiBearerAuth('JWT-auth')
@Controller('api/library/ingest')
@UseGuards(JwtAuthGuard)
export class IngestionController {
  constructor(private readonly ingestionService: IngestionService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Ingest an academic document from any source (DOI, BibTeX, PDF, Storage) into library',
  })
  async ingest(
    @CurrentUser('id') userId: string,
    @Body() dto: IngestDocumentDto,
  ) {
    return this.ingestionService.ingest(userId, dto);
  }

  @Post('batch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Batch ingest multiple academic documents with parallel resolution',
  })
  async batchIngest(
    @CurrentUser('id') userId: string,
    @Body() dto: BatchIngestDto,
  ) {
    return this.ingestionService.batchIngest(userId, dto);
  }
}
