import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CitationService } from './citation.service';
import {
  ExportBibtexDto,
  ImportBibtexDto,
  FormatCitationQueryDto,
  FormatBatchCitationDto,
} from './dto/citation.dto';
import { JwtAuthGuard } from '@/modules/iam/authentication';
import { CurrentUser } from '@/modules/iam/authentication';

@ApiTags('Library - Citations')
@ApiBearerAuth('JWT-auth')
@Controller('api/library/citations')
@UseGuards(JwtAuthGuard)
export class CitationController {
  constructor(private readonly citationService: CitationService) {}

  @Get(':workspaceId/items/:itemId/citation')
  @ApiOperation({
    summary:
      'Format catalog item into standard citation style (APA, IEEE, Nature, Harvard, Chicago, MLA, Vancouver)',
  })
  async formatCitation(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Query() query: FormatCitationQueryDto,
  ) {
    return this.citationService.formatCitation(
      workspaceId,
      itemId,
      query.style,
    );
  }

  @Post(':workspaceId/batch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Batch format multiple items into standard citation style',
  })
  async formatBatchCitations(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: FormatBatchCitationDto,
  ) {
    return this.citationService.formatBatchCitations(workspaceId, dto);
  }

  @Get(':workspaceId/bibtex')
  @ApiOperation({
    summary: 'Export workspace or collection items to BibTeX format',
  })
  async exportWorkspaceBibtex(
    @Param('workspaceId') workspaceId: string,
    @Query() query: ExportBibtexDto,
  ) {
    return this.citationService.exportWorkspaceBibtex(
      workspaceId,
      query.collectionId,
    );
  }

  @Post(':workspaceId/import-bibtex')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Bulk import raw BibTeX text entries into workspace library',
  })
  async importBibtex(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ImportBibtexDto,
  ) {
    return this.citationService.importBibtex(workspaceId, userId, dto);
  }

  @Post('parse-ris')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Parse raw RIS text without saving' })
  async parseRis(@Body('content') content: string) {
    return this.citationService.parseRis(content);
  }

  @Post(':workspaceId/import-ris')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Bulk import RIS text entries into workspace library',
  })
  async importRis(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: { content: string; collectionId?: string },
  ) {
    return this.citationService.importRis(workspaceId, userId, dto);
  }

  @Get(':workspaceId/items/:itemId/ris')
  @ApiOperation({ summary: 'Export single item into RIS format' })
  async exportRis(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.citationService.exportRis(workspaceId, itemId);
  }
}
