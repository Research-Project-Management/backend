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
  async listLibraryCollections(@Req() req: RequestWithUser) {
    const userId = req?.user?.id || req?.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return this.citationsService.listUserLibraryCollections(userId);
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
}
