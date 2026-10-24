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
  ResolvedProject,
} from '@/modules/project/access';
import { UserRateLimit, UserRateLimitGuard } from '@/core';
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

@ApiTags('Manuscripts - Spelling & Dictionaries')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/manuscripts/projects/:projectId/spelling')
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
    @Param('projectId') routeProjectId: string,
    @Body() dto: CheckSpellingDto,
    @Req() req: RequestWithUser,
    @ResolvedProject() project?: string | { id?: string },
  ): Promise<SpellingReportDto> {
    try {
      const userId = req?.user?.id || req?.user?.sub || req?.user?.userId;
      if (!userId) {
        throw new UnauthorizedException('Authentication required');
      }
      const targetProjectId =
        (typeof project === 'string' ? project : project?.id) || routeProjectId;
      return await this.spellingService.checkDocumentSpelling(
        targetProjectId,
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
    @Param('projectId') routeProjectId: string,
    @ResolvedProject() project?: string | { id?: string },
  ): Promise<CustomDictionaryResponseDto> {
    const targetProjectId =
      (typeof project === 'string' ? project : project?.id) || routeProjectId;
    return this.spellingService.listProjectWords(targetProjectId);
  }

  @Post('dictionary/learn')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add a custom word to the project dictionary' })
  @ApiResponse({ status: 200, description: 'Word added to project dictionary' })
  async learnProjectWord(
    @Param('projectId') routeProjectId: string,
    @Body() dto: LearnWordDto,
    @ResolvedProject() project?: string | { id?: string },
  ) {
    try {
      const targetProjectId =
        (typeof project === 'string' ? project : project?.id) || routeProjectId;
      await this.spellingService.learnProjectWord(targetProjectId, dto.word);
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
    @Param('projectId') routeProjectId: string,
    @Param('word') word: string,
    @ResolvedProject() project?: string | { id?: string },
  ) {
    const targetProjectId =
      (typeof project === 'string' ? project : project?.id) || routeProjectId;
    const removed = await this.spellingService.unlearnProjectWord(
      targetProjectId,
      word,
    );
    return { success: true, removed, word };
  }
}

@ApiTags('Manuscripts - Spelling & Dictionaries')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/manuscripts/spelling')
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
