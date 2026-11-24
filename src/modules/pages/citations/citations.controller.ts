/**
 * citations/citations.controller.ts
 * REST Controller exposing the 4 canonical Citations & Bibliography endpoints.
 */

import {
  BadRequestException,
  Body,
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
  ResolvedSpace,
} from '@/modules/project/access';
import { UserRateLimit, UserRateLimitGuard } from '@/core';
import { resolvePageControllerCoordinates } from '@/modules/pages/core/page-scope.helper';
import { CitationsService } from './citations.service';
import {
  CitationQueryDto,
  ResolveIdentifierDto,
  SyncLibraryDto,
  ListCitationsResponseDto,
  BibMutationResponseDto,
  UpsertCitationEntriesDto,
} from './dto/citations.dto';
import { IdentifierNotFoundException, InvalidBibtexException } from './domain';

interface RequestWithUser {
  user?: { id?: string; sub?: string; userId?: string };
  headers?: Record<string, string | string[] | undefined>;
}

@ApiTags('Manuscripts - Citations & Bibliography')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages/spaces/:spaceId/citations')
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
    summary: 'List or search citation entries in the project .bib files',
  })
  @ApiResponse({ status: 200, type: ListCitationsResponseDto })
  async listCitations(
    @Param('spaceId') routeSpaceId: string,
    @Query() queryDto: CitationQueryDto,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Param('pageId') routePageId?: string,
    @Query('pageId') queryPageId?: string,
    @Req() req?: RequestWithUser,
  ): Promise<ListCitationsResponseDto> {
    try {
      const { spaceId, pageId } = resolvePageControllerCoordinates(
        { spaceId: routeSpaceId, pageId: routePageId },
        resolvedSpace,
        queryPageId ?? queryDto?.pageId,
        req,
      );
      return await this.citationsService.listCitations(
        spaceId,
        queryDto,
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
      'Format and upsert structured citation entries or raw BibTeX into a project .bib file',
  })
  @ApiResponse({ status: 200, type: BibMutationResponseDto })
  async upsertEntries(
    @Param('spaceId') routeSpaceId: string,
    @Body() dto: UpsertCitationEntriesDto,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Param('pageId') routePageId?: string,
    @Query('pageId') queryPageId?: string,
    @Req() req?: RequestWithUser,
  ): Promise<BibMutationResponseDto> {
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

  @Post('resolve')
  @UseGuards(UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('import')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Resolve academic DOI / arXiv / ISBN identifier and append BibTeX to project',
  })
  @ApiResponse({ status: 200, type: BibMutationResponseDto })
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
  ): Promise<BibMutationResponseDto> {
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

  @Post('sync-library')
  @UseGuards(UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('import')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Sync reference collection from library or external provider into project .bib file',
  })
  @ApiResponse({ status: 200, type: BibMutationResponseDto })
  async syncLibrary(
    @Param('spaceId') routeSpaceId: string,
    @Body() dto: SyncLibraryDto,
    @Req() req: RequestWithUser,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Param('pageId') routePageId?: string,
    @Query('pageId') queryPageId?: string,
  ): Promise<BibMutationResponseDto> {
    const userId = req?.user?.id || req?.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    try {
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
}
