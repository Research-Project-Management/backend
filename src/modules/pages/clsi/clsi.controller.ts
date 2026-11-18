/**
 * modules/manuscripts/clsi/clsi.controller.ts
 * NestJS Controller exposing CLSI compilation, SyncTeX, and artifact endpoints.
 */

import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  ResolvedSpace,
  NoProjectContext,
  RequireOperator,
  OperatorGuard,
} from '@/modules/project/access';
import { FastifyReply } from 'fastify';
import { UserRateLimit, UserRateLimitGuard } from '@/core';
import { ClsiService } from './services/clsi.service';
import {
  CompileManuscriptDto,
  ClsiWordCountDto,
  ClsiAiTransformDto,
  ClsiAiFixErrorDto,
  ClsiAiGenerateTableDto,
} from './dto/clsi.dto';
import { ForwardSyncDto, ReverseSyncDto } from './dto/synctex.dto';

@ApiTags('Pages - CLSI')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
@UseGuards(JwtAuthGuard)
export class ClsiController {
  constructor(private readonly clsiService: ClsiService) {}

  @Post(['compile', 'spaces/:spaceId/compile', 'pages/:pageId/compile'])
  @UseGuards(ProjectAccessGuard, UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('compile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Compile LaTeX manuscript source to PDF via CLSI',
  })
  async compile(
    @Body() dto: CompileManuscriptDto,
    @CurrentUser('id') userId: string,
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') routePageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
  ) {
    const authorizedSpaceId =
      (typeof resolvedSpace === 'string' ? resolvedSpace : resolvedSpace?.id) ||
      routeSpaceId;
    if (authorizedSpaceId && !dto.spaceId) {
      dto.spaceId = authorizedSpaceId;
    }
    if (routePageId && !dto.pageId) {
      dto.pageId = routePageId;
    }
    return this.clsiService.compile(dto, userId, authorizedSpaceId);
  }

  @Post(['spaces/:spaceId/compile/cancel', 'pages/:pageId/compile/cancel'])
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel an ongoing compilation for a manuscript page or project',
  })
  cancelCompile(
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') routePageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
  ) {
    const spaceId =
      (typeof resolvedSpace === 'string' ? resolvedSpace : resolvedSpace?.id) ||
      routeSpaceId ||
      routePageId ||
      '';
    const targetId = routePageId || spaceId;
    const cancelled = this.clsiService.cancelCompile(targetId);
    return { success: true, cancelled };
  }

  @Post([
    'word-count',
    'spaces/:spaceId/word-count',
    'pages/:pageId/word-count',
  ])
  @UseGuards(ProjectAccessGuard, UserRateLimitGuard)
  @RequireRole(Role.REVIEWER)
  @UserRateLimit('compile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Calculate academic word count and metrics (texcount parity)',
  })
  async wordCount(
    @Body() dto: ClsiWordCountDto,
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') routePageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
  ) {
    const authorizedSpaceId =
      (typeof resolvedSpace === 'string' ? resolvedSpace : resolvedSpace?.id) ||
      routeSpaceId;
    if (authorizedSpaceId && !dto.spaceId) {
      dto.spaceId = authorizedSpaceId;
    }
    if (routePageId && !dto.pageId) {
      dto.pageId = routePageId;
    }
    return this.clsiService.getWordCount(dto, authorizedSpaceId);
  }

  @Post([
    'synctex/forward',
    'spaces/:spaceId/clsi/synctex/forward',
    'spaces/:spaceId/synctex/forward',
    'pages/:pageId/clsi/synctex/forward',
    'pages/:pageId/synctex/forward',
  ])
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.REVIEWER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Forward SyncTeX: map LaTeX source line/column to PDF coordinates',
  })
  async forwardSync(
    @Body() dto: ForwardSyncDto,
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') routePageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
  ) {
    const authorizedSpaceId =
      (typeof resolvedSpace === 'string' ? resolvedSpace : resolvedSpace?.id) ||
      routeSpaceId;
    if (authorizedSpaceId && !dto.spaceId) {
      dto.spaceId = authorizedSpaceId;
    }
    if (routePageId && !dto.pageId) {
      dto.pageId = routePageId;
    }
    return this.clsiService.forwardSync(dto, authorizedSpaceId);
  }

  @Post([
    'synctex/reverse',
    'spaces/:spaceId/clsi/synctex/reverse',
    'spaces/:spaceId/synctex/reverse',
    'pages/:pageId/clsi/synctex/reverse',
    'pages/:pageId/synctex/reverse',
  ])
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.REVIEWER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Reverse SyncTeX: map clicked PDF page coordinates to LaTeX source line/column',
  })
  async reverseSync(
    @Body() dto: ReverseSyncDto,
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') routePageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
  ) {
    const authorizedSpaceId =
      (typeof resolvedSpace === 'string' ? resolvedSpace : resolvedSpace?.id) ||
      routeSpaceId;
    if (authorizedSpaceId && !dto.spaceId) {
      dto.spaceId = authorizedSpaceId;
    }
    if (routePageId && !dto.pageId) {
      dto.pageId = routePageId;
    }
    return this.clsiService.reverseSync(dto, authorizedSpaceId);
  }

  @Get(['spaces/:spaceId/artifacts', 'pages/:pageId/artifacts'])
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.REVIEWER)
  @ApiOperation({
    summary: 'List auxiliary files generated by CLSI compilation',
  })
  async listAuxFiles(
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') routePageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
  ) {
    const spaceId =
      (typeof resolvedSpace === 'string' ? resolvedSpace : resolvedSpace?.id) ||
      routeSpaceId ||
      routePageId ||
      '';
    return this.clsiService.listAuxFiles(spaceId, routePageId);
  }

  @Get([
    'spaces/:spaceId/artifacts/:filename',
    'pages/:pageId/artifacts/:filename',
  ])
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.REVIEWER)
  @ApiOperation({ summary: 'Download a specific auxiliary file' })
  async downloadAuxFile(
    @Param('filename') filename: string,
    @Res() res: FastifyReply,
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') routePageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
  ) {
    const spaceId =
      (typeof resolvedSpace === 'string' ? resolvedSpace : resolvedSpace?.id) ||
      routeSpaceId ||
      routePageId ||
      '';
    return this.clsiService.downloadAuxFile(
      spaceId,
      filename,
      res,
      routePageId,
    );
  }

  @Get(['spaces/:spaceId/artifacts-zip', 'pages/:pageId/artifacts-zip'])
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.REVIEWER)
  @ApiOperation({
    summary: 'Download all project output artifacts packaged as a ZIP archive',
  })
  async downloadAllArtifactsZip(
    @Res() res: FastifyReply,
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') routePageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
  ) {
    const spaceId =
      (typeof resolvedSpace === 'string' ? resolvedSpace : resolvedSpace?.id) ||
      routeSpaceId ||
      routePageId ||
      '';
    return this.clsiService.downloadAllArtifactsZip(spaceId, res, routePageId);
  }

  @Post(['spaces/:spaceId/clean-aux', 'pages/:pageId/clean-aux'])
  @Delete(['spaces/:spaceId/artifacts', 'pages/:pageId/artifacts'])
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Clear cached auxiliary files and compile scratch workspace for a manuscript page or project',
  })
  async cleanAuxFiles(
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') routePageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
  ) {
    const spaceId =
      (typeof resolvedSpace === 'string' ? resolvedSpace : resolvedSpace?.id) ||
      routeSpaceId ||
      routePageId ||
      '';
    return this.clsiService.cleanProjectScratch(spaceId, routePageId);
  }

  @Get('clsi/status')
  @NoProjectContext()
  @ApiOperation({
    summary: 'Check health status and probe TeX Live compiler binaries',
  })
  async getStatus() {
    return this.clsiService.getHealthReport();
  }

  @Get('clsi/metrics')
  @UseGuards(OperatorGuard)
  @RequireOperator()
  @NoProjectContext()
  @ApiOperation({
    summary: 'Prometheus metrics endpoint for CLSI compilation performance',
  })
  async getMetrics(@Res() res: FastifyReply) {
    const metricsText = this.clsiService.getPrometheusMetrics();
    res.header('Content-Type', 'text/plain; version=0.0.4');
    return res.send(metricsText);
  }

  @Get('clsi/metrics/summary')
  @UseGuards(OperatorGuard)
  @RequireOperator()
  @NoProjectContext()
  @ApiOperation({ summary: 'JSON metrics summary of compilation statistics' })
  getMetricsSummary() {
    return this.clsiService.getMetricsSummary();
  }

  @Post('clsi/admin/clean-scratch')
  @UseGuards(OperatorGuard)
  @RequireOperator()
  @NoProjectContext()
  @ApiOperation({
    summary: 'Trigger LRU garbage collection and disk quota enforcement',
  })
  async cleanScratch() {
    const staleStats = await this.clsiService.cleanStaleScratch();
    const quotaStats = await this.clsiService.enforceScratchQuota();
    return { staleStats, quotaStats };
  }

  @Post('clsi/ai/transform')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit('search-replace')
  @NoProjectContext()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Transform academic LaTeX/Markdown text while masking math, citation, and reference macros',
  })
  async transformAcademicText(@Body() dto: ClsiAiTransformDto) {
    return this.clsiService.transformAcademicText(dto);
  }

  @Post('clsi/ai/fix-error')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit('search-replace')
  @NoProjectContext()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Analyze a LaTeX compilation error and suggest an automated or heuristic fix',
  })
  async fixLatexError(@Body() dto: ClsiAiFixErrorDto) {
    return this.clsiService.fixLatexError(dto);
  }

  @Post('clsi/ai/generate-table')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit('search-replace')
  @NoProjectContext()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate a clean LaTeX tabular or TSV table from a prompt',
  })
  async generateLatexTable(@Body() dto: ClsiAiGenerateTableDto) {
    return this.clsiService.generateLatexTable(dto);
  }
}
