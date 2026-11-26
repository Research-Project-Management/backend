/**
 * spelling/spelling.controller.ts
 * REST Controller for Project-scoped Spelling Check & Custom Dictionary.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
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
import { SpellingService } from './spelling.service';
import {
  CheckSpellingDto,
  CustomDictionaryResponseDto,
  LearnWordDto,
  SpellingReportDto,
} from './dto/spelling.dto';

interface AuthenticatedRequest {
  user?: { id?: string; sub?: string; userId?: string };
  headers?: Record<string, string | string[] | undefined>;
}

@ApiTags('Pages - Spelling & Dictionary')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages/spaces/:spaceId/spelling')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class SpellingController {
  constructor(private readonly spellingService: SpellingService) {}

  private resolveSpaceId(
    spaceIdParam?: string,
    resolvedSpace?: string | { id?: string },
    req?: AuthenticatedRequest,
  ): string {
    return resolvePageControllerCoordinates(
      { spaceId: spaceIdParam },
      resolvedSpace,
      undefined,
      req,
    ).spaceId;
  }

  @Post('check')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit('search-replace')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check unique words extracted from LaTeX prose and return suggestions',
  })
  @ApiResponse({ status: 200, type: SpellingReportDto })
  @ApiResponse({ status: 400, description: 'Unsupported language' })
  async check(
    @Body() body: CheckSpellingDto,
    @Param('spaceId') spaceIdParam?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<SpellingReportDto> {
    const spaceId = this.resolveSpaceId(spaceIdParam, resolvedSpace, req);
    return this.spellingService.check(spaceId, body);
  }

  @Get('dictionary')
  @ApiOperation({ summary: 'List custom words learned in this project' })
  @ApiResponse({ status: 200, type: CustomDictionaryResponseDto })
  async listDictionary(
    @Param('spaceId') spaceIdParam?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<CustomDictionaryResponseDto> {
    const spaceId = this.resolveSpaceId(spaceIdParam, resolvedSpace, req);
    return this.spellingService.listWords(spaceId);
  }

  @Post('dictionary')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add a custom word to the project dictionary' })
  @ApiResponse({ status: 200, description: 'Word added to project dictionary' })
  async learnWord(
    @Body() body: LearnWordDto,
    @Req() req: AuthenticatedRequest,
    @Param('spaceId') spaceIdParam?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
  ) {
    const spaceId = this.resolveSpaceId(spaceIdParam, resolvedSpace, req);
    const userId = req?.user?.id || req?.user?.sub || req?.user?.userId;
    const word = await this.spellingService.learnWord(spaceId, body.word, userId);
    return { success: true, word };
  }

  @Delete('dictionary/:word')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a custom word from the project dictionary' })
  async unlearnWord(
    @Param('word') word: string,
    @Param('spaceId') spaceIdParam?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ) {
    const spaceId = this.resolveSpaceId(spaceIdParam, resolvedSpace, req);
    const normalizedWord = (word ?? '').trim().toLowerCase();
    const removed = await this.spellingService.unlearnWord(spaceId, normalizedWord);
    return { success: true, removed, word: normalizedWord };
  }
}
