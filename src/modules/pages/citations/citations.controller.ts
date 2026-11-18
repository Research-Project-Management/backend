/**
 * citations/citations.controller.ts
 * REST Controllers exposing Citations, BibTeX Autocomplete, DOI/arXiv Resolver,
 * and Library Sync endpoints.
 */

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  NoProjectContext,
  ResolvedSpace,
} from '@/modules/project/access';
import { UserRateLimit, UserRateLimitGuard } from '@/core';
import { resolvePageControllerCoordinates } from '@/modules/pages/core/page-scope.helper';
import { CitationsService } from './citations.service';
import {
  CitationQueryDto,
  ResolveIdentifierDto,
  SyncLibraryDto,
  ParseRawBibtexDto,
  BibEntryDto,
  CitationValidationDto,
  SyncLibraryResultDto,
  RefactorCitationKeyDto,
  RefactorCitationKeyResultDto,
  UpsertCitationEntriesDto,
  UpsertCitationEntriesResultDto,
  InjectBibliographyDto,
} from './dto/citations.dto';
import { IdentifierNotFoundException, InvalidBibtexException } from './domain';

interface RequestWithUser {
  user?: { id?: string; sub?: string; userId?: string };
  headers?: Record<string, string | string[] | undefined>;
}

@ApiTags('Manuscripts - Citations & Bibliography')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/pages/spaces/:spaceId/citations',
  'api/v1/pages/:pageId/citations',
  'api/v1/pages/pages/:pageId/citations',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class CitationsController {
  constructor(private readonly citationsService: CitationsService) {}

  private handleError(error: unknown): never {
    if (error instanceof IdentifierNotFoundException) {
      throw new NotFoundException(error.message);
    }
    if (error instanceof InvalidBibtexException) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }

  @Get()
  @RequireRole(Role.REVIEWER)
  @ApiOperation({
    summary: 'List all citation entries in the project',
  })
  @ApiResponse({ status: 200, type: [BibEntryDto] })
  async listProjectCitations(
    @Param('spaceId') routeSpaceId: string,
    @Query() queryDto: CitationQueryDto,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Param('pageId') routePageId?: string,
    @Query('pageId') queryPageId?: string,
    @Req() req?: RequestWithUser,
  ): Promise<BibEntryDto[]> {
    try {
      const { spaceId, pageId } = resolvePageControllerCoordinates(
        { spaceId: routeSpaceId, pageId: routePageId },
        resolvedSpace,
        queryPageId ?? queryDto?.pageId,
        req,
      );
      return await this.citationsService.searchCitationKeys(
        spaceId,
        {
          query: queryDto.query,
          limit: queryDto.limit ?? 500,
          pageId,
        },
        pageId,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('search')
  @RequireRole(Role.REVIEWER)
  @ApiOperation({
    summary:
      'Search citation keys in the project to power \\cite{...} autocomplete',
  })
  @ApiResponse({ status: 200, type: [BibEntryDto] })
  async searchCitationKeys(
    @Param('spaceId') routeSpaceId: string,
    @Query() queryDto: CitationQueryDto,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Param('pageId') routePageId?: string,
    @Query('pageId') queryPageId?: string,
    @Req() req?: RequestWithUser,
  ): Promise<BibEntryDto[]> {
    try {
      const { spaceId, pageId } = resolvePageControllerCoordinates(
        { spaceId: routeSpaceId, pageId: routePageId },
        resolvedSpace,
        queryPageId ?? queryDto?.pageId,
        req,
      );
      return await this.citationsService.searchCitationKeys(
        spaceId,
        queryDto,
        pageId,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('resolve')
  @UseGuards(UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('import')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Resolve academic DOI / arXiv identifier and append BibTeX to project',
  })
  @ApiResponse({
    status: 200,
    description: 'BibTeX entry resolved and appended',
  })
  @ApiResponse({
    status: 404,
    description: 'Academic identifier not found or unsupported',
  })
  async resolveIdentifier(
    @Param('spaceId') routeSpaceId: string,
    @Body() dto: ResolveIdentifierDto,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Param('pageId') routePageId?: string,
    @Query('pageId') queryPageId?: string,
    @Req() req?: RequestWithUser,
  ) {
    try {
      const { spaceId, pageId } = resolvePageControllerCoordinates(
        { spaceId: routeSpaceId, pageId: routePageId },
        resolvedSpace,
        queryPageId ?? dto?.pageId,
        req,
      );
      return await this.citationsService.resolveIdentifier(
        spaceId,
        dto,
        pageId,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('validate')
  @RequireRole(Role.REVIEWER)
  @ApiOperation({
    summary:
      'Validate all project .bib files for duplicate keys or missing metadata',
  })
  @ApiResponse({ status: 200, type: CitationValidationDto })
  async validateBibtex(
    @Param('spaceId') routeSpaceId: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Param('pageId') routePageId?: string,
    @Query('pageId') queryPageId?: string,
    @Req() req?: RequestWithUser,
  ): Promise<CitationValidationDto> {
    try {
      const { spaceId, pageId } = resolvePageControllerCoordinates(
        { spaceId: routeSpaceId, pageId: routePageId },
        resolvedSpace,
        queryPageId,
        req,
      );
      return await this.citationsService.validateProjectBibtex(spaceId, pageId);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('sync-library')
  @UseGuards(UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('import')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sync bibliography collection from external library (Zotero/Flux)',
  })
  @ApiResponse({ status: 200, type: SyncLibraryResultDto })
  async syncLibrary(
    @Param('spaceId') routeSpaceId: string,
    @Body() dto: SyncLibraryDto,
    @Req() req: RequestWithUser,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Param('pageId') routePageId?: string,
    @Query('pageId') queryPageId?: string,
  ): Promise<SyncLibraryResultDto> {
    try {
      const userId = req?.user?.id || req?.user?.sub;
      if (!userId) {
        throw new UnauthorizedException('Authentication required');
      }
      const { spaceId, pageId } = resolvePageControllerCoordinates(
        { spaceId: routeSpaceId, pageId: routePageId },
        resolvedSpace,
        queryPageId ?? dto?.pageId,
        req,
      );
      return await this.citationsService.syncLibraryCollection(
        spaceId,
        userId,
        dto,
        pageId,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('references.bib')
  @RequireRole(Role.REVIEWER)
  @ApiOperation({
    summary: 'Virtual .bib stream projection for live editor compilation',
  })
  async getVirtualProjectBibtex(
    @Param('spaceId') routeSpaceId: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Param('pageId') routePageId?: string,
    @Query('pageId') queryPageId?: string,
    @Req() req?: RequestWithUser,
  ): Promise<string> {
    const { spaceId, pageId } = resolvePageControllerCoordinates(
      { spaceId: routeSpaceId, pageId: routePageId },
      resolvedSpace,
      queryPageId,
      req,
    );
    return this.citationsService.getVirtualProjectBibtex(spaceId, pageId);
  }

  @Post('refactor')
  @UseGuards(UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('search-replace')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Atomically rename a citation key across all project .bib and .tex/.md files',
  })
  @ApiResponse({ status: 200, type: RefactorCitationKeyResultDto })
  async refactorCitationKey(
    @Param('spaceId') routeSpaceId: string,
    @Body() dto: RefactorCitationKeyDto,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Param('pageId') routePageId?: string,
    @Query('pageId') queryPageId?: string,
    @Req() req?: RequestWithUser,
  ): Promise<RefactorCitationKeyResultDto> {
    try {
      const { spaceId, pageId } = resolvePageControllerCoordinates(
        { spaceId: routeSpaceId, pageId: routePageId },
        resolvedSpace,
        queryPageId ?? dto?.pageId,
        req,
      );
      return await this.citationsService.refactorCitationKey(
        spaceId,
        dto,
        pageId,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('entries')
  @UseGuards(UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('import')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Format and upsert structured citation entries or BibTeX into a project .bib file',
  })
  @ApiResponse({ status: 200, type: UpsertCitationEntriesResultDto })
  async upsertEntries(
    @Param('spaceId') routeSpaceId: string,
    @Body() dto: UpsertCitationEntriesDto,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Param('pageId') routePageId?: string,
    @Query('pageId') queryPageId?: string,
    @Req() req?: RequestWithUser,
  ): Promise<UpsertCitationEntriesResultDto> {
    try {
      const { spaceId, pageId } = resolvePageControllerCoordinates(
        { spaceId: routeSpaceId, pageId: routePageId },
        resolvedSpace,
        queryPageId ?? dto?.pageId,
        req,
      );
      return await this.citationsService.upsertEntries(spaceId, dto, pageId);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('inject-bibliography')
  @UseGuards(UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('search-replace')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Generate and inject a formatted bibliography section (\\bibitem or Markdown) into a manuscript document',
  })
  async injectBibliography(
    @Param('spaceId') routeSpaceId: string,
    @Body() dto: InjectBibliographyDto,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Param('pageId') routePageId?: string,
    @Query('pageId') queryPageId?: string,
    @Req() req?: RequestWithUser,
  ) {
    try {
      const { spaceId } = resolvePageControllerCoordinates(
        { spaceId: routeSpaceId, pageId: routePageId },
        resolvedSpace,
        queryPageId ?? dto?.pageId,
        req,
      );
      return await this.citationsService.injectBibliography(spaceId, dto);
    } catch (err) {
      this.handleError(err);
    }
  }
}

@ApiTags('Manuscripts - Citations & Bibliography')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages/citations')
@UseGuards(JwtAuthGuard)
@NoProjectContext()
export class CitationsUtilityController {
  constructor(private readonly citationsService: CitationsService) {}

  @Get('library-collections')
  @NoProjectContext()
  @ApiOperation({
    summary: 'List available bibliography collections from external library',
  })
  async listLibraryCollections(
    @Req() req: RequestWithUser,
    @Query('spaceId') spaceId?: string,
  ) {
    const userId = req?.user?.id || req?.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return this.citationsService.listUserLibraryCollections(userId, spaceId);
  }

  @Post('parse-raw')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit('search-replace')
  @NoProjectContext()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Parse raw BibTeX text content in memory' })
  @ApiResponse({ status: 200, type: [BibEntryDto] })
  @ApiResponse({ status: 400, description: 'Malformed or invalid BibTeX' })
  parseRawBibtex(@Body() dto: ParseRawBibtexDto): BibEntryDto[] {
    try {
      return this.citationsService.parseRawBibtex(dto.rawBibtex);
    } catch (err: unknown) {
      if (err instanceof InvalidBibtexException) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  @Post('format-bibitem')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit('search-replace')
  @NoProjectContext()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Format and inject a bibliography section (\\bibitem or Markdown) in memory',
  })
  async formatBibitem(@Body() dto: InjectBibliographyDto) {
    return this.citationsService.injectBibliography(null, dto);
  }
}
