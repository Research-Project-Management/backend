import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { LibraryIngestionService } from './library-ingestion.service';
import { IngestDocumentDto, BatchIngestDto } from './dto/ingestion.dto';
import { JwtAuthGuard } from '@/core/guards/jwt-auth.guard';
import { CurrentUser } from '@/core/decorators/current-user.decorator';

@ApiTags('Library - Ingestion')
@ApiBearerAuth('JWT-auth')
@Controller('api/library/ingest')
@UseGuards(JwtAuthGuard)
export class LibraryIngestionController {
  constructor(private readonly ingestionService: LibraryIngestionService) {}

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
