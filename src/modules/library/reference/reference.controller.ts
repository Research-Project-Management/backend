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
import { ReferenceService } from './reference.service';
import {
  ResolveQueryDto,
  ResolveDoiDto,
  CreateReferenceDto,
  ExportBibtexDto,
  ImportBibtexDto,
  FormatCitationQueryDto,
  FormatBatchCitationDto,
} from './dto/reference.dto';

import { JwtAuthGuard } from '@/modules/iam/authentication';
import { CurrentUser } from '@/modules/iam/authentication';

@ApiTags('Library - References')
@ApiBearerAuth('JWT-auth')
@Controller('api/library/references')
@UseGuards(JwtAuthGuard)
export class ReferenceController {
  constructor(private readonly referenceService: ReferenceService) {}

  @Get(':workspaceId/papers/:paperId/citation')
  @ApiOperation({
    summary:
      'Format paper into standard citation style (APA, IEEE, Nature, Harvard, Chicago, MLA, Vancouver)',
  })
  async formatPaperCitation(
    @Param('workspaceId') workspaceId: string,
    @Param('paperId') paperId: string,
    @Query() query: FormatCitationQueryDto,
  ) {
    return this.referenceService.formatPaperCitation(
      workspaceId,
      paperId,
      query.style,
    );
  }

  @Post(':workspaceId/citations/batch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Batch format multiple papers into standard citation style',
  })
  async formatBatchCitations(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: FormatBatchCitationDto,
  ) {
    return this.referenceService.formatBatchCitations(workspaceId, dto);
  }

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Resolve academic metadata from any query string (DOI, arXiv ID, URL, Title) across Semantic Scholar, CrossRef, and arXiv',
  })
  async resolve(@Body() dto: ResolveQueryDto) {
    return this.referenceService.resolve(dto.query);
  }

  @Post('resolve-doi')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve academic metadata from a DOI string via CrossRef',
  })
  async resolveDoiPost(@Body() dto: ResolveDoiDto) {
    return this.referenceService.resolveDoi(dto.doi);
  }

  @Get('doi/:doi')
  @ApiOperation({ summary: 'Lookup academic metadata from a DOI' })
  async resolveDoiParam(@Param('doi') doi: string) {
    return this.referenceService.resolveDoi(doi);
  }

  @Post(':workspaceId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Create an academic reference item in a workspace (without requiring PDF)',
  })
  async createReference(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateReferenceDto,
  ) {
    return this.referenceService.createReference(workspaceId, userId, dto);
  }

  @Get(':workspaceId/bibtex')
  @ApiOperation({
    summary: 'Export workspace or collection references to BibTeX format',
  })
  async exportWorkspaceBibtex(
    @Param('workspaceId') workspaceId: string,
    @Query() query: ExportBibtexDto,
  ) {
    return this.referenceService.exportWorkspaceBibtex(
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
    return this.referenceService.importBibtex(workspaceId, userId, dto);
  }

  @Post('parse-ris')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Parse raw RIS text without saving' })
  async parseRis(@Body('content') content: string) {
    return this.referenceService.parseRis(content);
  }

  @Post(':workspaceId/import-ris')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Bulk import RIS text entries into workspace library' })
  async importRis(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: { content: string; collectionId?: string },
  ) {
    return this.referenceService.importRis(workspaceId, userId, dto);
  }

  @Get(':workspaceId/papers/:paperId/ris')
  @ApiOperation({ summary: 'Export single paper into RIS format' })
  async exportRis(
    @Param('workspaceId') workspaceId: string,
    @Param('paperId') paperId: string,
  ) {
    return this.referenceService.exportRis(workspaceId, paperId);
  }
}

