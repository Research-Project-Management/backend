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
  ResolvedProject,
  NoProjectContext,
  RequireOperator,
  OperatorGuard,
} from '@/modules/project/access';
import { FastifyReply } from 'fastify';
import { UserRateLimit, UserRateLimitGuard } from '@/core';
import { ClsiService } from './clsi.service';
import { CompileManuscriptDto, ClsiWordCountDto } from './dto/clsi.dto';
import { ForwardSyncDto, ReverseSyncDto } from './dto/synctex.dto';

@ApiTags('Manuscripts - CLSI')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class ClsiController {
  constructor(private readonly clsiService: ClsiService) {}

  @Post([
    'v1/manuscripts/compile',
    'v1/manuscripts/projects/:projectId/compile',
    'manuscripts/compile',
    'clsi/compile',
    'compiler/compile',
    'latex/compile',
  ])
  @UseGuards(ProjectAccessGuard, UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('compile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Compile LaTeX manuscript source to PDF via Overleaf-parity CLSI',
  })
  async compile(
    @Body() dto: CompileManuscriptDto,
    @CurrentUser('id') userId: string,
    @Param('projectId') routeProjectId?: string,
    @ResolvedProject() project?: { id: string },
  ) {
    const authorizedProjectId = project?.id || routeProjectId;
    if (authorizedProjectId && !dto.projectId && !dto.project_id) {
      dto.projectId = authorizedProjectId;
      dto.project_id = authorizedProjectId;
    }
    return this.clsiService.compile(dto, userId, authorizedProjectId);
  }

  @Post([
    'v1/manuscripts/projects/:projectId/compile/cancel',
    'projects/:projectId/clsi/compile/cancel',
    'projects/:projectId/compiler/compile/cancel',
  ])
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an ongoing compilation for a project' })
  async cancelCompile(
    @Param('projectId') routeProjectId: string,
    @ResolvedProject() project?: { id: string },
  ) {
    const projectId = project?.id || routeProjectId;
    const cancelled = this.clsiService.cancelCompile(projectId);
    return { success: true, cancelled };
  }

  @Post([
    'v1/manuscripts/word-count',
    'v1/manuscripts/clsi/word-count',
    'manuscripts/word-count',
    'clsi/word-count',
    'compiler/word-count',
    'latex/word-count',
  ])
  @NoProjectContext()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Calculate academic word count and metrics (texcount parity)',
  })
  async wordCount(@Body() dto: ClsiWordCountDto) {
    return this.clsiService.getWordCount(dto);
  }

  @Post([
    'v1/manuscripts/synctex/forward',
    'synctex/forward',
    'manuscripts/synctex/forward',
    'clsi/synctex/forward',
    'latex/synctex/forward',
    'projects/:projectId/clsi/synctex/forward',
  ])
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.REVIEWER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Forward SyncTeX: map LaTeX source line/column to PDF coordinates',
  })
  async forwardSync(
    @Body() dto: ForwardSyncDto,
    @Param('projectId') routeProjectId?: string,
    @ResolvedProject() project?: { id: string },
  ) {
    const authorizedProjectId = project?.id || routeProjectId;
    if (authorizedProjectId && !dto.projectId && !dto.project_id) {
      dto.projectId = authorizedProjectId;
      dto.project_id = authorizedProjectId;
    }
    return this.clsiService.forwardSync(dto, authorizedProjectId);
  }

  @Post([
    'v1/manuscripts/synctex/reverse',
    'synctex/reverse',
    'manuscripts/synctex/reverse',
    'clsi/synctex/reverse',
    'latex/synctex/reverse',
    'projects/:projectId/clsi/synctex/reverse',
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
    @Param('projectId') routeProjectId?: string,
    @ResolvedProject() project?: { id: string },
  ) {
    const authorizedProjectId = project?.id || routeProjectId;
    if (authorizedProjectId && !dto.projectId && !dto.project_id) {
      dto.projectId = authorizedProjectId;
      dto.project_id = authorizedProjectId;
    }
    return this.clsiService.reverseSync(dto, authorizedProjectId);
  }

  @Get([
    'v1/manuscripts/projects/:projectId/artifacts',
    'projects/:projectId/artifacts',
    ':projectId/clsi/artifacts',
    ':projectId/compiler/artifacts',
  ])
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.REVIEWER)
  @ApiOperation({
    summary: 'List auxiliary files generated by CLSI compilation',
  })
  async listAuxFiles(
    @Param('projectId') routeProjectId: string,
    @ResolvedProject() project?: { id: string },
  ) {
    const projectId = project?.id || routeProjectId;
    return this.clsiService.listAuxFiles(projectId);
  }

  @Get([
    'v1/manuscripts/projects/:projectId/artifacts/:filename',
    'projects/:projectId/artifacts/:filename',
    ':projectId/clsi/artifacts/:filename',
    ':projectId/compiler/artifacts/:filename',
  ])
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.REVIEWER)
  @ApiOperation({ summary: 'Download a specific auxiliary file' })
  async downloadAuxFile(
    @Param('projectId') routeProjectId: string,
    @Param('filename') filename: string,
    @Res() res: FastifyReply,
    @ResolvedProject() project?: { id: string },
  ) {
    const projectId = project?.id || routeProjectId;
    return this.clsiService.downloadAuxFile(projectId, filename, res);
  }

  @Get([
    'v1/manuscripts/projects/:projectId/artifacts-zip',
    'projects/:projectId/artifacts-zip',
    ':projectId/clsi/artifacts-zip',
    ':projectId/compiler/artifacts-zip',
  ])
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.REVIEWER)
  @ApiOperation({
    summary: 'Download all project output artifacts packaged as a ZIP archive',
  })
  async downloadAllArtifactsZip(
    @Param('projectId') routeProjectId: string,
    @Res() res: FastifyReply,
    @ResolvedProject() project?: { id: string },
  ) {
    const projectId = project?.id || routeProjectId;
    return this.clsiService.downloadAllArtifactsZip(projectId, res);
  }

  @Post([
    'v1/manuscripts/projects/:projectId/clean-aux',
    'projects/:projectId/clean-aux',
    'projects/:projectId/clsi/clean-aux',
    'projects/:projectId/compiler/clean-aux',
  ])
  @Delete([
    'v1/manuscripts/projects/:projectId/artifacts',
    'projects/:projectId/artifacts',
    'projects/:projectId/clsi/artifacts',
  ])
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Clear cached auxiliary files and compile scratch workspace for a project',
  })
  async cleanAuxFiles(
    @Param('projectId') routeProjectId: string,
    @ResolvedProject() project?: { id: string },
  ) {
    const projectId = project?.id || routeProjectId;
    return this.clsiService.cleanProjectScratch(projectId);
  }

  @Get(['v1/manuscripts/clsi/status', 'clsi/status', 'manuscripts/clsi/status'])
  @UseGuards(OperatorGuard)
  @RequireOperator()
  @NoProjectContext()
  @ApiOperation({
    summary: 'Check health status and probe TeX Live compiler binaries',
  })
  async getStatus() {
    return this.clsiService.getHealthReport();
  }

  @Get([
    'v1/manuscripts/clsi/metrics',
    'clsi/metrics',
    'manuscripts/clsi/metrics',
  ])
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

  @Get([
    'v1/manuscripts/clsi/metrics/summary',
    'clsi/metrics/summary',
    'manuscripts/clsi/metrics/summary',
  ])
  @UseGuards(OperatorGuard)
  @RequireOperator()
  @NoProjectContext()
  @ApiOperation({ summary: 'JSON metrics summary of compilation statistics' })
  async getMetricsSummary() {
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
}
