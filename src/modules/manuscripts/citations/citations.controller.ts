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
import {
  IdentifierNotFoundException,
  DuplicateCitationKeyException,
  InvalidBibtexException,
} from './domain';

interface RequestWithUser {
  user?: { id?: string; sub?: string; userId?: string };
  headers?: Record<string, string | string[] | undefined>;
}

@ApiTags('Manuscripts - Citations & Bibliography')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/manuscripts/projects/:projectId/citations',
  'v1/manuscripts/projects/:projectId/citations',
  'manuscripts/projects/:projectId/citations',
  'projects/:projectId/citations',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class CitationsController {
  constructor(private readonly citationsService: CitationsService) {}

  private handleError(error: unknown): never {
    if (error instanceof IdentifierNotFoundException) {
      throw new NotFoundException(error.message);
    }
    if (error instanceof DuplicateCitationKeyException) {
      throw new ConflictException(error.message);
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
    @Param('projectId') projectId: string,
    @Query() queryDto: CitationQueryDto,
    @ResolvedProject() project?: { id: string },
  ): Promise<BibEntryDto[]> {
    try {
      const targetProjectId = project?.id || projectId;
      return await this.citationsService.searchCitationKeys(
        targetProjectId,
        queryDto,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('resolve')
  @RequireRole(Role.CONTRIBUTOR)
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
    @Param('projectId') projectId: string,
    @Body() dto: ResolveIdentifierDto,
    @ResolvedProject() project?: { id: string },
  ) {
    try {
      const targetProjectId = project?.id || projectId;
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
    @Param('projectId') projectId: string,
    @ResolvedProject() project?: { id: string },
  ): Promise<CitationValidationDto> {
    try {
      const targetProjectId = project?.id || projectId;
      return await this.citationsService.validateProjectBibtex(targetProjectId);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('sync-library')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sync bibliography collection from external library (Zotero/Flux)',
  })
  @ApiResponse({ status: 200, type: SyncLibraryResultDto })
  async syncLibrary(
    @Param('projectId') projectId: string,
    @Body() dto: SyncLibraryDto,
    @Req() req: RequestWithUser,
    @ResolvedProject() project?: { id: string },
  ): Promise<SyncLibraryResultDto> {
    try {
      const userId = req?.user?.id || req?.user?.sub;
      if (!userId) {
        throw new UnauthorizedException('Authentication required');
      }
      const targetProjectId = project?.id || projectId;
      return await this.citationsService.syncLibraryCollection(
        targetProjectId,
        userId,
        dto,
      );
    } catch (err) {
      this.handleError(err);
    }
  }
}

@ApiTags('Manuscripts - Citations & Bibliography')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/manuscripts/citations',
  'manuscripts/citations',
  'citations',
])
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
