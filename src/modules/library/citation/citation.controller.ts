import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { CitationService } from './citation.service';
import { FormatCitationDto, FormatBatchCitationDto } from './dto/citation.dto';

@Controller([
  'api/v1/workspaces/:workspaceId/library/citation',
  'api/library/references',
  'api/library/cite',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class CitationController {
  constructor(private readonly citationService: CitationService) {}

  @Get('styles')
  getStyles() {
    return this.citationService.getAvailableStyles();
  }

  @Post('format')
  format(@Body() dto: FormatCitationDto) {
    return this.citationService.formatItem(
      dto.item,
      dto.styleId || 'apa-7th',
      dto.index || 1,
    );
  }

  @Post('batch')
  formatBatch(@Body() dto: FormatBatchCitationDto) {
    return this.citationService.formatBatch(
      dto.items || [],
      dto.styleId || 'apa-7th',
    );
  }

  @Post('resolve-doi')
  async resolveDoiPost(@Body('doi') doi: string) {
    return this.citationService.resolveDoi(doi);
  }

  @Get(['doi/:doi', 'doi/*'])
  async getDoiReference(@Param('doi') paramDoi: string, @Req() req: any) {
    const rawUrl = req.raw?.url || req.url || '';
    const prefix = '/doi/';
    const idx = rawUrl.indexOf(prefix);
    const rawKey =
      idx !== -1 ? rawUrl.slice(idx + prefix.length).split('?')[0] : paramDoi;
    const cleanDoi = decodeURIComponent(rawKey || paramDoi);
    return this.citationService.resolveDoi(cleanDoi);
  }

  @Get('crossref/search')
  async searchCrossRef(
    @Query('query') query: string,
    @Query('rows') rows?: string,
  ) {
    const numRows = rows ? parseInt(rows, 10) : 5;
    return this.citationService.searchCrossRef(query, numRows);
  }

  @Post('resolve')
  async resolveAcademicQuery(@Body('query') query: string) {
    const work = await this.citationService.resolveDoi(query);
    return {
      query,
      queryType: 'DOI',
      provider: 'crossref',
      metadata: work,
    };
  }

  @Get(':workspaceId/papers/:paperId/citation')
  async getPaperCitation(
    @Param('workspaceId') workspaceId: string,
    @Param('paperId') paperId: string,
    @Query('style') style?: string,
    @Query('index') index?: string,
  ) {
    const styleId = (style as any) || 'apa-7th';
    const numIndex = index ? parseInt(index, 10) : 1;
    return this.citationService.formatPaperById(
      workspaceId,
      paperId,
      styleId,
      numIndex,
    );
  }

  @Post(':workspaceId/citations/batch')
  async getPaperBatchCitations(
    @Param('workspaceId') workspaceId: string,
    @Body('paperIds') paperIds: string[],
    @Body('style') style?: string,
  ) {
    const styleId = (style as any) || 'apa-7th';
    const ids = Array.isArray(paperIds) ? paperIds : [];
    return this.citationService.formatPaperBatch(workspaceId, ids, styleId);
  }
}
