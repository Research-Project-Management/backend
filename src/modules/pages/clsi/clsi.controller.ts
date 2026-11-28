/**
 * clsi.controller.ts
 * REST controller for LaTeX compilation, SyncTeX, word count, and output artifacts.
 */

import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  ResolvedSpace,
  NoProjectContext,
  RequireOperator,
  OperatorGuard,
} from '@/modules/project/access';
import { FastifyReply, FastifyRequest } from 'fastify';
import { UserRateLimit, UserRateLimitGuard } from '@/core';
import { ClsiService } from './clsi.service';
import { CompilePageDto, ClsiWordCountDto } from './dto/compile.dto';
import { ForwardSyncDto, ReverseSyncDto } from './dto/synctex.dto';

@ApiTags('Pages - CLSI')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages/clsi')
@UseGuards(JwtAuthGuard)
export class ClsiController {
  constructor(private readonly clsiService: ClsiService) {}

  private resolveSpaceId(
    resolvedSpace?: string | { id?: string },
    req?: FastifyRequest,
  ): string {
    const reqSpaceId =
      req && typeof req === 'object'
        ? (req as { resolvedSpaceId?: string }).resolvedSpaceId
        : undefined;
    return (
      (typeof resolvedSpace === 'string' ? resolvedSpace : resolvedSpace?.id) ||
      reqSpaceId ||
      ''
    );
  }

  private resolveReqPageId(req?: FastifyRequest): string | undefined {
    const reqPageId =
      req && typeof req === 'object'
        ? (req as { resolvedPageId?: string }).resolvedPageId
        : undefined;
    return typeof reqPageId === 'string' && reqPageId.trim()
      ? reqPageId.trim()
      : undefined;
  }

  private bindAuthorizedDtoScope(
    dto: { spaceId?: string; pageId?: string },
    resolvedSpace?: string | { id?: string },
    req?: FastifyRequest,
  ): string | undefined {
    const authorizedSpaceId = this.resolveSpaceId(resolvedSpace, req);
    if (authorizedSpaceId && !dto.spaceId) {
      dto.spaceId = authorizedSpaceId;
    }
    const reqPageId = this.resolveReqPageId(req);
    if (reqPageId && !dto.pageId) {
      dto.pageId = reqPageId;
    }
    return authorizedSpaceId || undefined;
  }

  private resolvePageRouteScope(
    pageIdParam: string,
    resolvedSpace?: string | { id?: string },
    req?: FastifyRequest,
  ): { authorizedSpaceId: string; candidatePageId: string; targetSpaceOrPageId: string } {
    const authorizedSpaceId = this.resolveSpaceId(resolvedSpace, req);
    const candidatePageId = this.resolveReqPageId(req) || pageIdParam;
    return {
      authorizedSpaceId,
      candidatePageId,
      targetSpaceOrPageId: authorizedSpaceId || candidatePageId,
    };
  }

  @Post('compile')
  @UseGuards(ProjectAccessGuard, UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('compile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Compile LaTeX source to PDF via CLSI' })
  async compile(
    @Body() dto: CompilePageDto,
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
  ) {
    const authorizedSpaceId = this.bindAuthorizedDtoScope(
      dto,
      resolvedSpace,
      req,
    );

    const clientAbort = new AbortController();
    const onClientClose = () => {
      if (!req.raw.complete) {
        clientAbort.abort();
      }
    };
    req.raw.once('close', onClientClose);

    try {
      return await this.clsiService.compile(
        dto,
        userId,
        authorizedSpaceId,
        clientAbort.signal,
      );
    } finally {
      req.raw.removeListener('close', onClientClose);
    }
  }

  @Delete('pages/:pageId/compile')
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an ongoing compilation' })
  async cancelCompile(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    const { authorizedSpaceId, candidatePageId } = this.resolvePageRouteScope(
      pageId,
      resolvedSpace,
      req,
    );
    const cancelled = await this.clsiService.cancelCompile(
      candidatePageId,
      userId,
      authorizedSpaceId || undefined,
    );
    return { success: true, cancelled };
  }

  @Post('word-count')
  @UseGuards(ProjectAccessGuard, UserRateLimitGuard)
  @RequireRole(Role.REVIEWER)
  @UserRateLimit('compile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Calculate document word count via TeXcount' })
  async wordCount(
    @Body() dto: ClsiWordCountDto,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    const authorizedSpaceId = this.bindAuthorizedDtoScope(
      dto,
      resolvedSpace,
      req,
    );
    return this.clsiService.getWordCount(dto, authorizedSpaceId);
  }

  @Post('synctex/forward')
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.REVIEWER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Forward SyncTeX: map LaTeX source line/column to PDF coordinates',
  })
  async forwardSync(
    @Body() dto: ForwardSyncDto,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    const authorizedSpaceId = this.bindAuthorizedDtoScope(
      dto,
      resolvedSpace,
      req,
    );
    return this.clsiService.forwardSync(dto, authorizedSpaceId);
  }

  @Post('synctex/reverse')
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.REVIEWER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Reverse SyncTeX: map PDF page coordinates to LaTeX source line/column',
  })
  async reverseSync(
    @Body() dto: ReverseSyncDto,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    const authorizedSpaceId = this.bindAuthorizedDtoScope(
      dto,
      resolvedSpace,
      req,
    );
    return this.clsiService.reverseSync(dto, authorizedSpaceId);
  }

  @Get('pages/:pageId/artifacts')
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.REVIEWER)
  @ApiOperation({
    summary: 'List auxiliary files generated by CLSI compilation',
  })
  async listAuxFiles(
    @Param('pageId') pageId: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    const { targetSpaceOrPageId, candidatePageId } = this.resolvePageRouteScope(
      pageId,
      resolvedSpace,
      req,
    );
    return this.clsiService.listAuxFiles(targetSpaceOrPageId, candidatePageId);
  }

  @Get('pages/:pageId/artifacts/archive')
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.REVIEWER)
  @ApiOperation({ summary: 'Download all output artifacts as a ZIP archive' })
  async downloadAllArtifactsZip(
    @Param('pageId') pageId: string,
    @Res() res: FastifyReply,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    const { targetSpaceOrPageId, candidatePageId } = this.resolvePageRouteScope(
      pageId,
      resolvedSpace,
      req,
    );
    return this.clsiService.downloadAllArtifactsZip(
      targetSpaceOrPageId,
      res,
      candidatePageId,
    );
  }

  @Get('pages/:pageId/artifacts/:filename')
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.REVIEWER)
  @ApiOperation({ summary: 'Download a specific auxiliary file' })
  async downloadAuxFile(
    @Param('pageId') pageId: string,
    @Param('filename') filename: string,
    @Res() res: FastifyReply,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    const { targetSpaceOrPageId, candidatePageId } = this.resolvePageRouteScope(
      pageId,
      resolvedSpace,
      req,
    );
    return this.clsiService.downloadAuxFile(
      targetSpaceOrPageId,
      filename,
      res,
      candidatePageId,
    );
  }

  @Delete('pages/:pageId/artifacts')
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clear cached auxiliary files and compile scratch workspace',
  })
  async cleanAuxFiles(
    @Param('pageId') pageId: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    const { targetSpaceOrPageId, candidatePageId } = this.resolvePageRouteScope(
      pageId,
      resolvedSpace,
      req,
    );
    return this.clsiService.cleanScratch(targetSpaceOrPageId, candidatePageId);
  }

  @Get('status')
  @NoProjectContext()
  @ApiOperation({
    summary: 'Check health status and probe TeX Live compiler binaries',
  })
  async getStatus() {
    return this.clsiService.getHealthReport();
  }

  @Get('metrics')
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

  @Get('metrics/summary')
  @UseGuards(OperatorGuard)
  @RequireOperator()
  @NoProjectContext()
  @ApiOperation({ summary: 'JSON metrics summary of compilation statistics' })
  getMetricsSummary() {
    return this.clsiService.getMetricsSummary();
  }

  @Delete('scratch')
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
}
