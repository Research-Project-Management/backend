import { Controller, Get, Post, Body, Param, Query, UseGuards, NotFoundException, BadRequestException, Header } from '@nestjs/common';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { CitationService } from '@/modules/library/citation/services/citation.service';
import { FormatCitationDto, FormatBatchCitationDto, ExportLibraryDto, ExportByKeysDto, ExportFormatType } from '@/modules/library/citation/types/citation.types';
import { normalizeCitationStyleId } from '@/modules/library/citation/domain/citation.domain';
import { normalizeProjectScopeId } from '@/modules/library/core';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ProjectAccessGuard, ProjectRoles, ProjectRole } from '@/modules/project/access';
import { ExportsService } from '@/modules/library/citation/services/exports.service';

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
  @Header('Cache-Control', 'private, max-age=3600')
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
    @CurrentUser('id') userId: string,
    @Query('q') query?: string,
    @Query('limit') limit?: string,
    @Param('projectId') projectId?: string,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : 30;
    const numLimit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 200)
        : 30;
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    const styles = await this.citationService.searchStyles(
      query || '',
      numLimit,
      effectiveProjectId || userId,
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
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    return this.citationService.registerCustomStyle(
      xml,
      title,
      effectiveProjectId || userId,
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
    const hasContext = Boolean(
      dto.locator ||
        dto.label ||
        dto.prefix ||
        dto.suffix ||
        dto.suppressAuthor,
    );
    return this.citationService.formatItemAsync(
      dto.item,
      dto.styleId || 'apa-7th',
      dto.index || 1,
      hasContext
        ? {
            locator: dto.locator,
            label: dto.label,
            prefix: dto.prefix,
            suffix: dto.suffix,
            suppressAuthor: dto.suppressAuthor,
          }
        : undefined,
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
  @Header('Cache-Control', 'private, max-age=3600')
  async getDoiReference(
    @CurrentUser('id') userId: string,
    @Param('doi') doi: string,
  ) {
    let cleanDoi: string;
    try {
      cleanDoi = decodeURIComponent(doi);
    } catch {
      throw new BadRequestException('Malformed DOI URI parameter');
    }
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
    const parsedRows = rows ? parseInt(rows, 10) : 5;
    const numRows =
      Number.isFinite(parsedRows) && parsedRows > 0
        ? Math.min(parsedRows, 100)
        : 5;
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
  @Header('Cache-Control', 'private, max-age=3600')
  async getItemCitation(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Query('style') style?: string,
    @Query('index') index?: string,
    @Query('locator') locator?: string,
    @Query('label') label?: string,
    @Query('prefix') prefix?: string,
    @Query('suffix') suffix?: string,
    @Query('suppressAuthor') suppressAuthor?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') routeProjectId?: string,
  ) {
    const styleId = normalizeCitationStyleId(style);
    const parsedIndex = index ? parseInt(index, 10) : 1;
    const numIndex =
      Number.isFinite(parsedIndex) && parsedIndex > 0 ? parsedIndex : 1;
    const projectId =
      normalizeProjectScopeId(queryProjectId) ||
      normalizeProjectScopeId(routeProjectId);
    const isSuppressAuthor =
      suppressAuthor === 'true' || suppressAuthor === '1';
    const hasContext = Boolean(
      locator || label || prefix || suffix || isSuppressAuthor,
    );
    const res = await this.citationService.formatItemById(
      userId,
      itemId,
      styleId,
      numIndex,
      projectId,
      hasContext
        ? {
            locator,
            label,
            prefix,
            suffix,
            suppressAuthor: isSuppressAuthor,
          }
        : undefined,
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
    const projectId =
      normalizeProjectScopeId(bodyProjectId) ||
      normalizeProjectScopeId(queryProjectId) ||
      normalizeProjectScopeId(routeProjectId);
    return this.citationService.formatItemBatch(
      userId,
      ids,
      styleId,
      projectId,
    );
  }
}

@ApiTags('Library Exports')
@ApiBearerAuth()
@Controller([
  'api/v1/library/exports',
  'api/v1/projects/:projectId/library/exports',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  @Get('items/:itemId/annotated-pdf')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async exportAnnotatedPdf(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Param('projectId') routeProjectId?: string,
    @Query('projectId') queryProjectId?: string,
    @Query('attachmentId') attachmentId?: string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(
      routeProjectId || queryProjectId,
    );
    return this.exportsService.exportAnnotatedItemPdf(
      userId,
      itemId,
      undefined,
      effectiveProjectId,
      attachmentId,
    );
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async exportLibrary(
    @CurrentUser('id') userId: string,
    @Body() dto: ExportLibraryDto,
    @Param('projectId') routeProjectId?: string,
  ) {
    if (routeProjectId && !dto.projectId) {
      dto.projectId = routeProjectId;
    }
    return this.exportsService.exportLibrary(userId, dto);
  }

  @Post('by-keys')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async exportCitationsBibtex(
    @CurrentUser('id') userId: string,
    @Body() body: ExportByKeysDto,
    @Param('projectId') routeProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(
      routeProjectId || body.projectId || queryProjectId,
    );
    const result = await this.exportsService.exportByCitationKeys(
      userId,
      body.keys || [],
      effectiveProjectId,
      body.format || 'bibtex',
    );
    return {
      ...result,
      itemCount: result.itemCount ?? result.count,
      filename: result.filename ?? 'references.bib',
      bibtex: result.content,
    };
  }

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async exportLibraryGet(
    @CurrentUser('id') userId: string,
    @Param('projectId') routeProjectId?: string,
    @Query('format') format?: ExportFormatType,
    @Query('collectionId') collectionIdQuery?: string,
    @Query('tagId') tagId?: string,
    @Query('projectId') projectIdQuery?: string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(
      routeProjectId || projectIdQuery,
    );
    const effectiveFormat = format || 'bibtex';
    const queryDto: ExportLibraryDto = {
      format: effectiveFormat,
      collectionId: collectionIdQuery,
      tagId,
      projectId: effectiveProjectId,
    };

    const result = await this.exportsService.exportLibrary(userId, queryDto);

    return {
      ...result,
      bibtex: result.content,
      total: result.itemCount,
      filename: result.filename,
    };
  }

  @Get(':collectionId/export-bundle')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getCollectionBundle(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Param('projectId') routeProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.exportsService.exportBundle(
      userId,
      collectionId,
      normalizeProjectScopeId(routeProjectId || queryProjectId),
    );
  }
}
