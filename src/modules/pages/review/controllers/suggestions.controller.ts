import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthenticatedRequest } from '@/core';
import { CurrentUser, JwtAuthGuard } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  ResolvedSpace,
  Role,
} from '@/modules/project/access';
import { BatchResolveDto, CreateSuggestionDto } from '../dto/review.dto';
import { SuggestionsService } from '../services/suggestions.service';

@ApiTags('Manuscripts - Pages Review & Comments')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages/docs/:docId/suggestions')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class SuggestionsController {
  constructor(private readonly suggestionsService: SuggestionsService) {}

  @Get()
  async list(
    @Param('docId') docId: string,
    @Query('status') status?: 'pending' | 'accepted' | 'rejected',
    @ResolvedSpace() authSpace?: string | { id: string } | null,
  ) {
    return this.suggestionsService.list(docId, status, undefined, authSpace);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('docId') docId: string,
    @Body() body: CreateSuggestionDto,
    @Req() req: AuthenticatedRequest,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
  ) {
    return this.suggestionsService.create(
      docId,
      body,
      req,
      undefined,
      authSpace,
    );
  }

  @Post(':suggestionId/accept')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async accept(
    @Param('docId') docId: string,
    @Param('suggestionId') suggestionId: string,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
    @CurrentUser('id') userId?: string,
  ) {
    return this.suggestionsService.accept(
      docId,
      suggestionId,
      undefined,
      authSpace,
      userId,
    );
  }

  @Post(':suggestionId/reject')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async reject(
    @Param('docId') docId: string,
    @Param('suggestionId') suggestionId: string,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
    @CurrentUser('id') userId?: string,
  ) {
    return this.suggestionsService.reject(
      docId,
      suggestionId,
      undefined,
      authSpace,
      userId,
    );
  }

  @Post('batch-resolve')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async batchResolve(
    @Param('docId') docId: string,
    @Body() body: BatchResolveDto,
    @ResolvedSpace() authSpace: string | { id: string } | null,
    @Req() req?: AuthenticatedRequest,
  ) {
    const isAccept =
      body.action === 'accept' || body.action === 'accept_all';
    const resolvedCount = await this.suggestionsService.batchResolve(
      docId,
      authSpace,
      isAccept,
      body.suggestionIds,
      req?.user?.id || req?.user?.sub || null,
    );
    return {
      ok: true,
      action: body.action,
      resolvedCount,
      acceptedCount: isAccept ? resolvedCount : 0,
      rejectedCount: isAccept ? 0 : resolvedCount,
    };
  }
}
