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
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SpellingService } from './spelling.service';
import {
  CheckSpellingDto,
  LearnWordDto,
  SuggestionQueryDto,
  SpellingReportDto,
  CustomDictionaryResponseDto,
} from './dto/spelling.dto';
import { UnsupportedLanguageException } from './core/domain/exceptions/unsupported-language.exception';
import { InvalidWordException } from './core/domain/exceptions/invalid-word.exception';

@ApiTags('Manuscripts - Spelling & Dictionaries')
@Controller([
  'api/v1/manuscripts/projects/:projectId/spelling',
  'manuscripts/projects/:projectId/spelling',
  'projects/:projectId/spelling',
])
export class SpellingController {
  constructor(private readonly spellingService: SpellingService) {}

  private handleError(error: any): never {
    if (error instanceof UnsupportedLanguageException || error instanceof InvalidWordException) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }

  @Post('check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check LaTeX document spelling and return errors with suggestions' })
  @ApiResponse({ status: 200, type: SpellingReportDto })
  @ApiResponse({ status: 400, description: 'Unsupported language' })
  async checkSpelling(
    @Param('projectId') projectId: string,
    @Body() dto: CheckSpellingDto,
    @Req() req: any
  ): Promise<SpellingReportDto> {
    try {
      const userId = req?.user?.id || req?.headers?.['x-user-id'] || 'user-default';
      return await this.spellingService.checkDocumentSpelling(projectId, userId, dto);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('dictionary')
  @ApiOperation({ summary: 'List custom words learned in this project' })
  @ApiResponse({ status: 200, type: CustomDictionaryResponseDto })
  async listProjectDictionary(@Param('projectId') projectId: string): Promise<CustomDictionaryResponseDto> {
    return this.spellingService.listProjectWords(projectId);
  }

  @Post('dictionary/learn')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add a custom word to the project dictionary' })
  @ApiResponse({ status: 200, description: 'Word added to project dictionary' })
  async learnProjectWord(
    @Param('projectId') projectId: string,
    @Body() dto: LearnWordDto
  ) {
    try {
      await this.spellingService.learnProjectWord(projectId, dto.word);
      return { success: true, word: dto.word };
    } catch (err) {
      this.handleError(err);
    }
  }

  @Delete('dictionary/:word')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a custom word from the project dictionary' })
  async unlearnProjectWord(
    @Param('projectId') projectId: string,
    @Param('word') word: string
  ) {
    const removed = await this.spellingService.unlearnProjectWord(projectId, word);
    return { success: true, removed, word };
  }
}

@ApiTags('Manuscripts - Spelling & Dictionaries')
@Controller(['api/v1/manuscripts/spelling', 'manuscripts/spelling', 'spelling'])
export class SpellingUtilityController {
  constructor(private readonly spellingService: SpellingService) {}

  private handleError(error: any): never {
    if (error instanceof UnsupportedLanguageException || error instanceof InvalidWordException) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }

  @Get('suggestions')
  @ApiOperation({ summary: 'Get candidate spelling suggestions for a queried word' })
  getSuggestions(@Query() query: SuggestionQueryDto) {
    try {
      const suggestions = this.spellingService.getSuggestions(query);
      return { word: query.word, suggestions };
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('user-dictionary')
  @ApiOperation({ summary: 'List custom words learned in user personal dictionary' })
  @ApiResponse({ status: 200, type: CustomDictionaryResponseDto })
  async listUserDictionary(@Req() req: any): Promise<CustomDictionaryResponseDto> {
    const userId = req?.user?.id || req?.headers?.['x-user-id'] || 'user-default';
    return this.spellingService.listUserWords(userId);
  }

  @Post('user-dictionary/learn')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add a custom word to the user personal dictionary' })
  async learnUserWord(@Body() dto: LearnWordDto, @Req() req: any) {
    try {
      const userId = req?.user?.id || req?.headers?.['x-user-id'] || 'user-default';
      await this.spellingService.learnUserWord(userId, dto.word);
      return { success: true, word: dto.word };
    } catch (err) {
      this.handleError(err);
    }
  }

  @Delete('user-dictionary/:word')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a custom word from the user personal dictionary' })
  async unlearnUserWord(@Param('word') word: string, @Req() req: any) {
    const userId = req?.user?.id || req?.headers?.['x-user-id'] || 'user-default';
    const removed = await this.spellingService.unlearnUserWord(userId, word);
    return { success: true, removed, word };
  }
}
