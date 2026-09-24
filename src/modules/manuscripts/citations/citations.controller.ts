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
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
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
import { IdentifierNotFoundException } from './core/domain/exceptions/identifier-not-found.exception';
import { DuplicateCitationKeyException } from './core/domain/exceptions/duplicate-citation-key.exception';
import { InvalidBibtexException } from './core/domain/exceptions/invalid-bibtex.exception';

@ApiTags('Manuscripts - Citations & Bibliography')
@Controller([
  'api/v1/manuscripts/projects/:projectId/citations',
  'manuscripts/projects/:projectId/citations',
  'projects/:projectId/citations',
])
export class CitationsController {
  constructor(private readonly citationsService: CitationsService) {}

  private handleError(error: any): never {
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
  @ApiOperation({ summary: 'Search citation keys in the project to power \\cite{...} autocomplete' })
  @ApiResponse({ status: 200, type: [BibEntryDto] })
  async searchCitationKeys(
    @Param('projectId') projectId: string,
    @Query() queryDto: CitationQueryDto,
  ): Promise<BibEntryDto[]> {
    try {
      return await this.citationsService.searchCitationKeys(projectId, queryDto);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve academic DOI / arXiv identifier and append BibTeX to project' })
  @ApiResponse({ status: 200, description: 'BibTeX entry resolved and appended' })
  @ApiResponse({ status: 404, description: 'Academic identifier not found or unsupported' })
  async resolveIdentifier(
    @Param('projectId') projectId: string,
    @Body() dto: ResolveIdentifierDto,
  ) {
    try {
      return await this.citationsService.resolveIdentifier(projectId, dto);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('validate')
  @ApiOperation({ summary: 'Validate all project .bib files for duplicate keys or missing metadata' })
  @ApiResponse({ status: 200, type: CitationValidationDto })
  async validateBibtex(@Param('projectId') projectId: string): Promise<CitationValidationDto> {
    try {
      return await this.citationsService.validateProjectBibtex(projectId);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('sync-library')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sync bibliography collection from external library (Zotero/Flux)' })
  @ApiResponse({ status: 200, type: SyncLibraryResultDto })
  async syncLibrary(
    @Param('projectId') projectId: string,
    @Body() dto: SyncLibraryDto,
    @Req() req: any,
  ): Promise<SyncLibraryResultDto> {
    try {
      const userId = req?.user?.id || req?.headers?.['x-user-id'] || 'user-default';
      return await this.citationsService.syncLibraryCollection(projectId, userId, dto);
    } catch (err) {
      this.handleError(err);
    }
  }
}

@ApiTags('Manuscripts - Citations & Bibliography')
@Controller(['api/v1/manuscripts/citations', 'manuscripts/citations', 'citations'])
export class CitationsUtilityController {
  constructor(private readonly citationsService: CitationsService) {}

  @Get('library-collections')
  @ApiOperation({ summary: 'List available bibliography collections from external library' })
  async listLibraryCollections(@Req() req: any) {
    const userId = req?.user?.id || req?.headers?.['x-user-id'] || 'user-default';
    return this.citationsService.listUserLibraryCollections(userId);
  }

  @Post('parse-raw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Parse raw BibTeX text content in memory' })
  @ApiResponse({ status: 200, type: [BibEntryDto] })
  @ApiResponse({ status: 400, description: 'Malformed or invalid BibTeX' })
  parseRawBibtex(@Body() dto: ParseRawBibtexDto): BibEntryDto[] {
    try {
      return this.citationsService.parseRawBibtex(dto.rawBibtex);
    } catch (err: any) {
      if (err instanceof InvalidBibtexException) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }
}
