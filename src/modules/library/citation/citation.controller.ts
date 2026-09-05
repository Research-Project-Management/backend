import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { CurrentWorkspace } from '../../../modules/iam/authz/decorators/current-workspace.decorator';
import { CitationService } from './citation.service';
import { FormatCitationDto, FormatBatchCitationDto } from './dto/citation.dto';

@Controller([
  'api/v1/workspaces/:workspaceId/library/citation',
  'api/library/references',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class CitationController {
  constructor(private readonly citationService: CitationService) {}

  @Get('styles')
  getStyles() {
    return this.citationService.getAvailableStyles();
  }

  /**
   * Format a raw item object (not persisted) into a citation string.
   * Use GET /citation/items/:itemId/citation for persisted items.
   */
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

  /**
   * Resolve a DOI (or any academic identifier) to metadata.
   * Merged: was POST /resolve-doi + POST /resolve (both called resolveDoi).
   */
  @Post('resolve')
  async resolveDoi(@Body('doi') doi: string, @Body('query') query: string) {
    const work = await this.citationService.resolveDoi(doi || query);
    return { work, data: work, ...work };
  }

  /**
   * GET /citation/doi/:doi — for encoded DOIs (use encodeURIComponent on client).
   * Wildcard alias doi/* removed: client must encode slashes in DOI as %2F.
   */
  @Get('doi/:doi')
  async getDoiReference(@Param('doi') doi: string) {
    const work = await this.citationService.resolveDoi(decodeURIComponent(doi));
    return { work, data: work, ...work };
  }

  @Get('crossref/search')
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
  async getItemCitation(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('itemId') itemId: string,
    @Query('style') style?: string,
    @Query('index') index?: string,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    const styleId = (style as any) || 'apa-7th';
    const numIndex = index ? parseInt(index, 10) : 1;
    const res = await this.citationService.formatItemById(
      targetWsId,
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
  async getBatchCitations(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Body('itemIds') itemIds: string[],
    @Body('paperIds') paperIds?: string[],
    @Body('style') style?: string,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    const styleId = (style as any) || 'apa-7th';
    const ids = Array.isArray(itemIds)
      ? itemIds
      : Array.isArray(paperIds)
        ? paperIds
        : [];
    return this.citationService.formatItemBatch(targetWsId, ids, styleId);
  }
}
