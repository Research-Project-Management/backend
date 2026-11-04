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
  ResolvedProject,
} from '@/modules/project/access';
import { UserRateLimit, UserRateLimitGuard } from '@/core';
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
@Controller('api/v1/manuscripts/projects/:projectId/citations')
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
    @Param('projectId') routeProjectId: string,
    @Query() queryDto: CitationQueryDto,
    @ResolvedProject() project?: string | { id?: string },
  ): Promise<BibEntryDto[]> {
    try {
      const targetProjectId =
        (typeof project === 'string' ? project : project?.id) || routeProjectId;
      return await this.citationsService.searchCitationKeys(targetProjectId, {
        query: queryDto.query,
        limit: queryDto.limit ?? 500,
      });
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
    @Param('projectId') routeProjectId: string,
    @Query() queryDto: CitationQueryDto,
    @ResolvedProject() project?: string | { id?: string },
  ): Promise<BibEntryDto[]> {
    try {
      const targetProjectId =
        (typeof project === 'string' ? project : project?.id) || routeProjectId;
      return await this.citationsService.searchCitationKeys(
        targetProjectId,
        queryDto,
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
    @Param('projectId') routeProjectId: string,
    @Body() dto: ResolveIdentifierDto,
    @ResolvedProject() project?: string | { id?: string },
  ) {
    try {
      const targetProjectId =
        (typeof project === 'string' ? project : project?.id) || routeProjectId;
      return await this.citationsService.resolveIdentifier(
        targetProjectId,
        dto,
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
    @Param('projectId') routeProjectId: string,
    @ResolvedProject() project?: string | { id?: string },
  ): Promise<CitationValidationDto> {
    try {
      const targetProjectId =
        (typeof project === 'string' ? project : project?.id) || routeProjectId;
      return await this.citationsService.validateProjectBibtex(targetProjectId);
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
    @Param('projectId') routeProjectId: string,
    @Body() dto: SyncLibraryDto,
    @Req() req: RequestWithUser,
    @ResolvedProject() project?: string | { id?: string },
  ): Promise<SyncLibraryResultDto> {
    try {
      const userId = req?.user?.id || req?.user?.sub;
      if (!userId) {
        throw new UnauthorizedException('Authentication required');
      }
      const targetProjectId =
        (typeof project === 'string' ? project : project?.id) || routeProjectId;
      return await this.citationsService.syncLibraryCollection(
        targetProjectId,
        userId,
        dto,
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
    @Param('projectId') routeProjectId: string,
    @ResolvedProject() project?: string | { id?: string },
  ): Promise<string> {
    const targetProjectId =
      (typeof project === 'string' ? project : project?.id) || routeProjectId;
    return this.citationsService.getVirtualProjectBibtex(targetProjectId);
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
    @Param('projectId') routeProjectId: string,
    @Body() dto: RefactorCitationKeyDto,
    @ResolvedProject() project?: string | { id?: string },
  ): Promise<RefactorCitationKeyResultDto> {
    try {
      const targetProjectId =
        (typeof project === 'string' ? project : project?.id) || routeProjectId;
      return await this.citationsService.refactorCitationKey(
        targetProjectId,
        dto,
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
    @Param('projectId') routeProjectId: string,
    @Body() dto: UpsertCitationEntriesDto,
    @ResolvedProject() project?: string | { id?: string },
  ): Promise<UpsertCitationEntriesResultDto> {
    try {
      const targetProjectId =
        (typeof project === 'string' ? project : project?.id) || routeProjectId;
      return await this.citationsService.upsertEntries(targetProjectId, dto);
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
    @Param('projectId') routeProjectId: string,
    @Body() dto: InjectBibliographyDto,
    @ResolvedProject() project?: string | { id?: string },
  ) {
    try {
      const targetProjectId =
        (typeof project === 'string' ? project : project?.id) || routeProjectId;
      return await this.citationsService.injectBibliography(
        targetProjectId,
        dto,
      );
    } catch (err) {
      this.handleError(err);
    }
  }
}

@ApiTags('Manuscripts - Citations & Bibliography')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/manuscripts/citations')
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
    @Query('projectId') projectId?: string,
  ) {
    const userId = req?.user?.id || req?.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return this.citationsService.listUserLibraryCollections(userId, projectId);
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
