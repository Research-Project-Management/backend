import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  NotFoundException,
  Header,
} from '@nestjs/common';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { CitationService } from '@/modules/library/citation/services/citation.service';
import {
  FormatCitationDto,
  FormatBatchCitationDto,
} from '@/modules/library/citation/dto/citation.dto';
import { normalizeCitationStyleId } from '@/modules/library/citation/domain/citation.domain';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ProjectAccessGuard,
  ProjectRoles,
  ProjectRole,
} from '@/modules/project/access';

@ApiTags('Library Citation')
@ApiBearerAuth()
@Controller([
  'api/v1/projects/:projectId/library/citation',
  'api/v1/library/citation',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class CitationController {
  constructor(private readonly citationService: CitationService) {}

  @Get('styles')
  @ProjectRoles(
    ProjectRole.OWNER,
    ProjectRole.COORDINATOR,
    ProjectRole.CONTRIBUTOR,
    ProjectRole.REVIEWER,
  )
  @Header(
    'Cache-Control',
    'public, max-age=86400, stale-while-revalidate=604800',
  )
  getStyles() {
    return this.citationService.getAvailableStyles();
  }

  /**
   * Search across the 10,000+ official CSL Style repository.
   */
  @Get('styles/search')
  @ProjectRoles(
    ProjectRole.OWNER,
    ProjectRole.COORDINATOR,
    ProjectRole.CONTRIBUTOR,
    ProjectRole.REVIEWER,
  )
  async searchStyles(
    @Query('q') query?: string,
    @Query('limit') limit?: string,
  ) {
    const numLimit = limit ? parseInt(limit, 10) : 30;
    const styles = await this.citationService.searchStyles(
      query || '',
      numLimit,
    );
    return {
      total: styles.length,
      styles,
    };
  }

  /**
   * Upload and register a custom CSL XML stylesheet.
   */
  @Post('styles/custom')
  @ProjectRoles(
    ProjectRole.OWNER,
    ProjectRole.COORDINATOR,
    ProjectRole.CONTRIBUTOR,
  )
  async uploadCustomStyle(
    @CurrentUser('id') userId: string,
    @Body('xml') xml: string,
    @Body('title') title?: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.citationService.registerCustomStyle(
      xml,
      title,
      projectId || userId,
    );
  }

  /**
   * Format a raw item object (not persisted) into a citation string.
   * Use GET /citation/items/:itemId/citation for persisted items.
   */
  @Post('format')
  @ProjectRoles(
    ProjectRole.OWNER,
    ProjectRole.COORDINATOR,
    ProjectRole.CONTRIBUTOR,
    ProjectRole.REVIEWER,
  )
  format(@Body() dto: FormatCitationDto) {
    return this.citationService.formatItemAsync(
      dto.item,
      dto.styleId || 'apa-7th',
      dto.index || 1,
    );
  }

  @Post('batch')
  @ProjectRoles(
    ProjectRole.OWNER,
    ProjectRole.COORDINATOR,
    ProjectRole.CONTRIBUTOR,
    ProjectRole.REVIEWER,
  )
  formatBatch(@Body() dto: FormatBatchCitationDto) {
    return this.citationService.formatBatchAsync(
      dto.items || [],
      dto.styleId || 'apa-7th',
    );
  }

  /**
   * Resolve a DOI, arXiv ID, or title/query to academic metadata.
   * Gracefully returns { found: false, ... } without throwing 404 HTTP errors on misses.
   */
  @Post('resolve')
  @ProjectRoles(
    ProjectRole.OWNER,
    ProjectRole.COORDINATOR,
    ProjectRole.CONTRIBUTOR,
    ProjectRole.REVIEWER,
  )
  async resolve(
    @CurrentUser('id') userId: string,
    @Body('doi') doi?: string,
    @Body('query') query?: string,
  ) {
    const input = (query || doi || '').trim();
    const result = await this.citationService.resolveAcademicQuery(
      input,
      doi,
      userId,
    );
    return {
      found: result.found,
      data: result.work,
      queryType: result.queryType,
      provider: result.provider,
    };
  }

  /**
   * GET /citation/doi/:doi — for encoded DOIs (use encodeURIComponent on client).
   */
  @Get('doi/:doi')
  @ProjectRoles(
    ProjectRole.OWNER,
    ProjectRole.COORDINATOR,
    ProjectRole.CONTRIBUTOR,
    ProjectRole.REVIEWER,
  )
  @Header(
    'Cache-Control',
    'private, max-age=3600, stale-while-revalidate=86400',
  )
  async getDoiReference(
    @CurrentUser('id') userId: string,
    @Param('doi') doi: string,
  ) {
    const cleanDoi = decodeURIComponent(doi);
    const result = await this.citationService.resolveAcademicQuery(
      cleanDoi,
      cleanDoi,
      userId,
    );
    if (!result.found || !result.work) {
      throw new NotFoundException(`DOI not found on CrossRef (404)`);
    }
    return {
      found: true,
      data: result.work,
      provider: result.provider,
    };
  }

  @Get('crossref/search')
  @ProjectRoles(
    ProjectRole.OWNER,
    ProjectRole.COORDINATOR,
    ProjectRole.CONTRIBUTOR,
    ProjectRole.REVIEWER,
  )
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
  @ProjectRoles(
    ProjectRole.OWNER,
    ProjectRole.COORDINATOR,
    ProjectRole.CONTRIBUTOR,
    ProjectRole.REVIEWER,
  )
  @Header(
    'Cache-Control',
    'private, max-age=3600, stale-while-revalidate=86400',
  )
  async getItemCitation(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Query('style') style?: string,
    @Query('index') index?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') routeProjectId?: string,
  ) {
    const styleId = normalizeCitationStyleId(style);
    const numIndex = index ? parseInt(index, 10) : 1;
    const projectId = queryProjectId || routeProjectId;
    const res = await this.citationService.formatItemById(
      userId,
      itemId,
      styleId,
      numIndex,
      projectId,
    );
    return {
      ...res,
      style: res.styleId,
      html: res.bibliographyHtml,
    };
  }

  /**
   * Batch format citations for multiple item IDs.
   * Route: POST /citation/batch-items
   */
  @Post('batch-items')
  @ProjectRoles(
    ProjectRole.OWNER,
    ProjectRole.COORDINATOR,
    ProjectRole.CONTRIBUTOR,
    ProjectRole.REVIEWER,
  )
  async getBatchCitations(
    @CurrentUser('id') userId: string,
    @Body('itemIds') itemIds?: string[],
    @Body('style') style?: string,
    @Body('projectId') bodyProjectId?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') routeProjectId?: string,
  ) {
    const styleId = normalizeCitationStyleId(style);
    const rawIds = Array.isArray(itemIds) ? itemIds : [];
    // Safety guard: Deduplicate and cap batch at 100 items to protect Node.js event loop
    const ids = Array.from(new Set(rawIds)).slice(0, 100);
    const projectId = bodyProjectId || queryProjectId || routeProjectId;
    return this.citationService.formatItemBatch(
      userId,
      ids,
      styleId,
      projectId,
    );
  }
}
