/**
 * diagnostics/diagnostics.controller.ts
 * REST Controller exposing Diagnostics, Log Parsing, Linting, and Explanations.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
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
import {
  AuthenticatedRequest,
  UserRateLimit,
  UserRateLimitGuard,
} from '@/core';
import { resolvePageControllerCoordinates } from '@/modules/pages/core/page-scope.helper';
import { DiagnosticsService } from './diagnostics.service';
import {
  ParseLogDto,
  LintDocumentDto,
  DiagnosticReportDto,
  ErrorExplanationDto,
} from './dto/diagnostics.dto';
import {
  InvalidLogFormatException,
  ExplanationNotFoundException,
} from './domain';

@ApiTags('Pages - Diagnostics')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/pages/diagnostics',
  'api/v1/pages/spaces/:spaceId/diagnostics',
  'api/v1/pages/:pageId/diagnostics',
  'api/v1/pages/pages/:pageId/diagnostics',
])
@UseGuards(JwtAuthGuard)
export class DiagnosticsController {
  private readonly logger = new Logger(DiagnosticsController.name);

  constructor(private readonly diagnosticsService: DiagnosticsService) {}

  @Post('parse-log')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit('search-replace')
  @NoProjectContext()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Parse a raw TeX compilation log into structured diagnostics',
  })
  @ApiResponse({ status: 200, type: DiagnosticReportDto })
  @ApiResponse({ status: 400, description: 'Empty or invalid log text' })
  public parseLog(@Body() dto: ParseLogDto): DiagnosticReportDto {
    try {
      return this.diagnosticsService.parseCompileLog(dto);
    } catch (err: unknown) {
      if (
        err instanceof InvalidLogFormatException ||
        (err instanceof Error && err.name === 'InvalidLogFormatException')
      ) {
        const msg = err instanceof Error ? err.message : 'Invalid log format';
        this.logger.warn(`Invalid compilation log format: ${msg}`);
        throw new BadRequestException(msg);
      }
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(`Failed to parse compilation log: ${msg}`, stack);
      throw err;
    }
  }

  @Post('lint')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit('search-replace')
  @NoProjectContext()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Statically check LaTeX document syntax before compilation',
  })
  @ApiResponse({ status: 200, type: DiagnosticReportDto })
  public lintDocument(@Body() dto: LintDocumentDto): DiagnosticReportDto {
    return this.diagnosticsService.lintDocument(dto);
  }

  @Post([
    'lint-doc',
    'spaces/:spaceId/lint-doc',
    'pages/:pageId/lint-doc',
    ':spaceId/lint-doc',
  ])
  @UseGuards(ProjectAccessGuard, UserRateLimitGuard)
  @RequireRole(Role.REVIEWER)
  @UserRateLimit('search-replace')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Statically lint a single document against project citations and labels',
  })
  @ApiResponse({ status: 200, type: DiagnosticReportDto })
  public async lintProjectDocument(
    @Body() dto: LintDocumentDto,
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') routePageId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() authorizedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<DiagnosticReportDto> {
    const { spaceId, pageId } = resolvePageControllerCoordinates(
      { spaceId: routeSpaceId, pageId: routePageId },
      authorizedSpace,
      queryPageId ?? dto?.pageId,
      req,
    );
    return await this.diagnosticsService.lintProjectDocument(
      spaceId,
      dto,
      pageId,
    );
  }

  @Post(['spaces/:spaceId/lint', 'pages/:pageId/lint', ':spaceId/lint'])
  @UseGuards(ProjectAccessGuard, UserRateLimitGuard)
  @RequireRole(Role.REVIEWER)
  @UserRateLimit('search-replace')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Statically check LaTeX document syntax and citations for an entire project',
  })
  @ApiResponse({ status: 200, type: DiagnosticReportDto })
  public async lintProject(
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') routePageId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() authorizedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<DiagnosticReportDto> {
    const { spaceId, pageId } = resolvePageControllerCoordinates(
      { spaceId: routeSpaceId, pageId: routePageId },
      authorizedSpace,
      queryPageId,
      req,
    );
    return await this.diagnosticsService.lintProject(spaceId, pageId);
  }

  @Get('explain/:code')
  @NoProjectContext()
  @ApiOperation({
    summary: 'Retrieve detailed explanation and remedy for an error code',
  })
  @ApiResponse({ status: 200, type: ErrorExplanationDto })
  @ApiResponse({
    status: 404,
    description: 'Explanation code not found in knowledge base',
  })
  public getExplanation(@Param('code') code: string): ErrorExplanationDto {
    try {
      return this.diagnosticsService.getErrorExplanation(code);
    } catch (err) {
      if (err instanceof ExplanationNotFoundException) {
        throw new NotFoundException(err.message);
      }
      throw err;
    }
  }

  @Get('rules')
  @NoProjectContext()
  @ApiOperation({ summary: 'List all diagnostic and error explanation rules' })
  @ApiResponse({ status: 200, type: [ErrorExplanationDto] })
  public listAllRules(): ErrorExplanationDto[] {
    return this.diagnosticsService.listAllRules();
  }
}
