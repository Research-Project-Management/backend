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
import { CitationsService } from './services/citations.service';
import {
  CitationSyncQueueService,
  CitationSyncJobStatusDto,
} from './services/sync.service';
import {
  CitationQueryDto,
  ResolveIdentifierDto,
  SyncLibraryDto,
  ListCitationsResponseDto,
  BibMutationResponseDto,
  UpsertCitationEntriesDto,
} from './dto/citations.dto';
import {
  IdentifierNotFoundException,
  InvalidBibtexException,
} from './domain/citations.errors';

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
  constructor(
    private readonly citationsService: CitationsService,
    private readonly syncQueueService?: CitationSyncQueueService,
  ) {}

  private resolveUserId(req?: RequestWithUser): string {
    const userId = req?.user?.id || req?.user?.sub || req?.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return userId;
  }

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
    summary: 'List or search citation entries in the space .bib files',
  })
  @ApiResponse({ status: 200, type: ListCitationsResponseDto })
  async listCitations(
    @Param('spaceId') routeSpaceId: string,
    @Query() queryDto: CitationQueryDto,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Query('pageId') queryPageId?: string,
    @Req() req?: RequestWithUser,
  ): Promise<ListCitationsResponseDto> {
    try {
      const { spaceId, pageId } = resolvePageControllerCoordinates(
        { spaceId: routeSpaceId },
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
      'Format and upsert structured citation entries or raw BibTeX into a space .bib file',
  })
  @ApiResponse({ status: 200, type: BibMutationResponseDto })
  async upsertEntries(
    @Param('spaceId') routeSpaceId: string,
    @Body() dto: UpsertCitationEntriesDto,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Query('pageId') queryPageId?: string,
    @Req() req?: RequestWithUser,
  ): Promise<BibMutationResponseDto> {
    try {
      const { spaceId, pageId } = resolvePageControllerCoordinates(
        { spaceId: routeSpaceId },
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
      'Resolve academic DOI / arXiv / ISBN identifier and append BibTeX to space',
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
    @Query('pageId') queryPageId?: string,
    @Req() req?: RequestWithUser,
  ): Promise<BibMutationResponseDto> {
    try {
      const { spaceId, pageId } = resolvePageControllerCoordinates(
        { spaceId: routeSpaceId },
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
      'Sync reference collection from personal or team library into space .bib file',
  })
  @ApiResponse({ status: 200, type: BibMutationResponseDto })
  async syncLibrary(
    @Param('spaceId') routeSpaceId: string,
    @Body() dto: SyncLibraryDto,
    @Req() req: RequestWithUser,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Query('pageId') queryPageId?: string,
  ): Promise<BibMutationResponseDto> {
    const userId = this.resolveUserId(req);
    try {
      const { spaceId, pageId } = resolvePageControllerCoordinates(
        { spaceId: routeSpaceId },
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

  @Post('sync-library/async')
  @UseGuards(UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('import')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Enqueue async reference collection sync job via BullMQ (202 Accepted)',
  })
  async syncLibraryAsync(
    @Param('spaceId') routeSpaceId: string,
    @Body() dto: SyncLibraryDto,
    @Req() req: RequestWithUser,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Query('pageId') queryPageId?: string,
  ): Promise<{ jobId: string; status: 'queued' }> {
    const userId = this.resolveUserId(req);
    try {
      const { spaceId, pageId } = resolvePageControllerCoordinates(
        { spaceId: routeSpaceId },
        resolvedSpace,
        queryPageId ?? dto?.pageId,
        req,
      );
      if (!this.syncQueueService?.isAvailable()) {
        throw new BadRequestException('Async sync queue is not enabled');
      }
      return await this.syncQueueService.enqueueSync({
        spaceId,
        userId,
        dto,
        pageId,
      });
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('sync-library/:jobId')
  @RequireRole(Role.REVIEWER)
  @ApiOperation({
    summary: 'Check status and result of an async library sync job',
  })
  async getSyncJobStatus(
    @Param('jobId') jobId: string,
  ): Promise<CitationSyncJobStatusDto> {
    try {
      if (!this.syncQueueService) {
        throw new NotFoundException(`Sync job ${jobId} not found`);
      }
      return await this.syncQueueService.getJobStatus(jobId);
    } catch (err) {
      this.handleError(err);
    }
  }
}
