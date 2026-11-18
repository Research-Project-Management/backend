/**
 * spelling/spelling.controller.ts
 * REST Controllers exposing Spelling Check, Suggestions, and Custom Dictionaries.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { SpellingService } from './spelling.service';
import {
  CheckSpellingDto,
  LearnWordDto,
  SuggestionQueryDto,
  SpellingReportDto,
  CustomDictionaryResponseDto,
} from './dto/spelling.dto';
import { UnsupportedLanguageException, InvalidWordException } from './domain';

interface RequestWithUser {
  user?: { id?: string; sub?: string; userId?: string };
  headers?: Record<string, string | string[] | undefined>;
}

@ApiTags('Pages - Spelling & Dictionaries')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/pages/spaces/:spaceId/spelling',
  'api/v1/pages/:pageId/spelling',
  'api/v1/pages/pages/:pageId/spelling',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class SpellingController {
  constructor(private readonly spellingService: SpellingService) {}

  private handleError(error: unknown): never {
    if (
      error instanceof UnsupportedLanguageException ||
      error instanceof InvalidWordException
    ) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }

  @Post('check')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit('search-replace')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check LaTeX document spelling and return errors with suggestions',
  })
  @ApiResponse({ status: 200, type: SpellingReportDto })
  @ApiResponse({ status: 400, description: 'Unsupported language' })
  async checkSpelling(
    @Body() dto: CheckSpellingDto,
    @Req() req: RequestWithUser,
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') routePageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
  ): Promise<SpellingReportDto> {
    try {
      const userId = req?.user?.id || req?.user?.sub || req?.user?.userId;
      if (!userId) {
        throw new UnauthorizedException('Authentication required');
      }
      const { spaceId, pageId } = resolvePageControllerCoordinates(
        { spaceId: routeSpaceId, pageId: routePageId },
        resolvedSpace,
        dto.pageId,
        req,
      );
      if (!dto.pageId && pageId) {
        dto.pageId = pageId;
      }
      dto.docId = dto.docId ?? dto.pageId ?? routePageId;
      return await this.spellingService.checkDocumentSpelling(
        spaceId,
        userId,
        dto,
      );
    } catch (err: unknown) {
      this.handleError(err);
    }
  }

  @Get('dictionary')
  @ApiOperation({ summary: 'List custom words learned in this project' })
  @ApiResponse({ status: 200, type: CustomDictionaryResponseDto })
  async listProjectDictionary(
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') routePageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: RequestWithUser,
  ): Promise<CustomDictionaryResponseDto> {
    const { spaceId } = resolvePageControllerCoordinates(
      { spaceId: routeSpaceId, pageId: routePageId },
      resolvedSpace,
      undefined,
      req,
    );
    return this.spellingService.listProjectWords(spaceId);
  }

  @Post('dictionary/learn')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add a custom word to the project dictionary' })
  @ApiResponse({ status: 200, description: 'Word added to project dictionary' })
  async learnProjectWord(
    @Body() dto: LearnWordDto,
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') routePageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: RequestWithUser,
  ) {
    try {
      const { spaceId } = resolvePageControllerCoordinates(
        { spaceId: routeSpaceId, pageId: routePageId },
        resolvedSpace,
        undefined,
        req,
      );
      await this.spellingService.learnProjectWord(spaceId, dto.word);
      return { success: true, word: dto.word };
    } catch (err) {
      this.handleError(err);
    }
  }

  @Delete('dictionary/:word')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a custom word from the project dictionary' })
  async unlearnProjectWord(
    @Param('word') word: string,
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') routePageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: RequestWithUser,
  ) {
    const { spaceId } = resolvePageControllerCoordinates(
      { spaceId: routeSpaceId, pageId: routePageId },
      resolvedSpace,
      undefined,
      req,
    );
    const removed = await this.spellingService.unlearnProjectWord(
      spaceId,
      word,
    );
    return { success: true, removed, word };
  }
}

@ApiTags('Pages - Spelling & Dictionaries')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages/spelling')
@UseGuards(JwtAuthGuard)
@NoProjectContext()
export class SpellingUtilityController {
  constructor(private readonly spellingService: SpellingService) {}

  private handleError(error: unknown): never {
    if (
      error instanceof UnsupportedLanguageException ||
      error instanceof InvalidWordException
    ) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }

  @Get('suggestions')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit('search-replace')
  @NoProjectContext()
  @ApiOperation({
    summary: 'Get candidate spelling suggestions for a queried word',
  })
  getSuggestions(@Query() query: SuggestionQueryDto) {
    try {
      const suggestions = this.spellingService.getSuggestions(query);
      return { word: query.word, suggestions };
    } catch (err: unknown) {
      this.handleError(err);
    }
  }

  @Get('user-dictionary')
  @NoProjectContext()
  @ApiOperation({
    summary: 'List custom words learned in user personal dictionary',
  })
  @ApiResponse({ status: 200, type: CustomDictionaryResponseDto })
  async listUserDictionary(
    @Req() req: RequestWithUser,
  ): Promise<CustomDictionaryResponseDto> {
    const userId = req?.user?.id || req?.user?.sub || req?.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return this.spellingService.listUserWords(userId);
  }

  @Post('user-dictionary/learn')
  @NoProjectContext()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Add a custom word to the user personal dictionary',
  })
  async learnUserWord(@Body() dto: LearnWordDto, @Req() req: RequestWithUser) {
    try {
      const userId = req?.user?.id || req?.user?.sub || req?.user?.userId;
      if (!userId) {
        throw new UnauthorizedException('Authentication required');
      }
      await this.spellingService.learnUserWord(userId, dto.word);
      return { success: true, word: dto.word };
    } catch (err: unknown) {
      this.handleError(err);
    }
  }

  @Delete('user-dictionary/:word')
  @NoProjectContext()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove a custom word from the user personal dictionary',
  })
  async unlearnUserWord(
    @Param('word') word: string,
    @Req() req: RequestWithUser,
  ) {
    const userId = req?.user?.id || req?.user?.sub || req?.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    const removed = await this.spellingService.unlearnUserWord(userId, word);
    return { success: true, removed, word };
  }
}
