import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '../../../modules/iam/authz/decorators/workspace-roles.decorator';
import { CitationService } from './citation.service';
import { FormatCitationDto, FormatBatchCitationDto } from './dto/citation.dto';
import { normalizeCitationStyleId } from './utils/citation.utils';

@Controller([
  'api/v1/workspaces/:workspaceId/library/citation',
  'api/v1/workspace/:workspaceId/library/citation',
  'api/v1/library/citation',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class CitationController {
  constructor(private readonly citationService: CitationService) {}

  @Get('styles')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  getStyles() {
    return this.citationService.getAvailableStyles();
  }

  /**
   * Format a raw item object (not persisted) into a citation string.
   * Use GET /citation/items/:itemId/citation for persisted items.
   */
  @Post('format')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  format(@Body() dto: FormatCitationDto) {
    return this.citationService.formatItem(
      dto.item,
      dto.styleId || 'apa-7th',
      dto.index || 1,
    );
  }

  @Post('batch')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  formatBatch(@Body() dto: FormatBatchCitationDto) {
    return this.citationService.formatBatch(
      dto.items || [],
      dto.styleId || 'apa-7th',
    );
  }

  /**
   * Resolve a DOI, arXiv ID, or title/query to academic metadata.
   * Gracefully returns { found: false, ... } without throwing 404 HTTP errors on misses.
   */
  @Post('resolve')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async resolve(
    @Body('doi') doi?: string,
    @Body('query') query?: string,
    @Param('workspaceId') workspaceId?: string,
  ) {
    const input = (query || doi || '').trim();
    const result = await this.citationService.resolveAcademicQuery(
      input,
      doi,
      workspaceId,
    );
    return {
      found: result.found,
      work: result.work,
      data: result.work,
      metadata: result.work,
      queryType: result.queryType,
      provider: result.provider,
      ...(result.work || {}),
    };
  }

  /**
   * GET /citation/doi/:doi — for encoded DOIs (use encodeURIComponent on client).
   * Wildcard alias doi/* removed: client must encode slashes in DOI as %2F.
   */
  @Get('doi/:doi')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getDoiReference(
    @Param('doi') doi: string,
    @Param('workspaceId') workspaceId?: string,
  ) {
    const cleanDoi = decodeURIComponent(doi);
    const result = await this.citationService.resolveAcademicQuery(
      cleanDoi,
      cleanDoi,
      workspaceId,
    );
    if (!result.found || !result.work) {
      throw new NotFoundException(`DOI not found on CrossRef (404)`);
    }
    return {
      found: true,
      work: result.work,
      data: result.work,
      metadata: result.work,
      provider: result.provider,
      ...result.work,
    };
  }

  @Get('crossref/search')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async searchCrossRef(
    @Query('query') query: string,
    @Query('rows') rows?: string,
  ) {
    const numRows = rows ? parseInt(rows, 10) : 5;
    return this.citationService.searchCrossRef(query, numRows);
  }

  /**
   * Format citation for a persisted item by ID.
   * Route: GET /citation/items/:itemId/citation
   */
  @Get('items/:itemId/citation')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getItemCitation(
    @Param('itemId') itemId: string,
    @Param('workspaceId') workspaceId: string,
    @Query('style') style?: string,
    @Query('index') index?: string,
  ) {
    const styleId = normalizeCitationStyleId(style);
    const numIndex = index ? parseInt(index, 10) : 1;
    const res = await this.citationService.formatItemById(
      workspaceId,
      itemId,
      styleId,
      numIndex,
    );
    return {
      ...res,
      style: res.styleId,
      html: res.bibliographyHtml,
    };
  }

  /**
   * Batch format citations for multiple item IDs.
   * Route: POST /citation/batch
   */
  @Post('batch-items')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getBatchCitations(
    @Param('workspaceId') workspaceId: string,
    @Body('itemIds') itemIds?: string[],
    @Body('paperIds') paperIds?: string[],
    @Body('style') style?: string,
  ) {
    const styleId = normalizeCitationStyleId(style);
    const ids = Array.isArray(itemIds)
      ? itemIds
      : Array.isArray(paperIds)
        ? paperIds
        : [];
    return this.citationService.formatItemBatch(workspaceId, ids, styleId);
  }
}
