/**
 * project-history/project-history.controller.ts
 * REST API Controller for Manuscripts Project History, Snapshots, Diff & Labels.
 */

import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  HttpStatus,
  HttpCode,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ParseIntPipe,
  UseGuards,
  Req,
  Res,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  ResolvedSpace,
  Role,
} from '@/modules/project/access';
import { resolvePageControllerCoordinates } from '@/modules/pages/core/page-scope.helper';
import { ProjectHistoryService } from './project-history.service';
import {
  CreateSnapshotDto,
  LabelVersionDto,
  RestoreVersionDto,
  RestoreSingleFileDto,
  RestoreSingleFileResponseDto,
  DiffQueryDto,
  DiffResponseDto,
  SnapshotDetailDto,
  VersionListItemDto,
  VersionLabelDto,
} from './dto/history.dto';
import {
  VersionNotFoundException,
  DuplicateLabelException,
  EmptyProjectException,
  InvalidVersionLabelException,
} from './domain';
import { AuthenticatedRequest } from '@/core';

@ApiTags('Pages - Project History & Snapshots')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/pages/spaces/:spaceId/history',
  'api/v1/pages/pages/:pageId/history',
  'api/v1/pages/docs/:docId/history',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class ProjectHistoryController {
  constructor(private readonly historyService: ProjectHistoryService) {}

  private handleError(error: unknown): never {
    if (error instanceof VersionNotFoundException) {
      throw new NotFoundException(error.message);
    }
    if (error instanceof DuplicateLabelException) {
      throw new ConflictException(error.message);
    }
    if (
      error instanceof EmptyProjectException ||
      error instanceof InvalidVersionLabelException
    ) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }

  private resolveCoordinates(
    routeSpaceId: string | undefined,
    paramPageId: string | undefined,
    paramDocId: string | undefined,
    queryPageId: string | undefined,
    resolvedSpace: string | { id?: string } | null | undefined,
    req: unknown,
  ): { spaceId: string; pageId?: string } {
    return resolvePageControllerCoordinates(
      { spaceId: routeSpaceId, pageId: paramPageId, docId: paramDocId },
      resolvedSpace,
      queryPageId,
      req,
    );
  }

  @Get('')
  @ApiOperation({
    summary: 'Get project history events and versions overview',
  })
  async getProjectHistory(
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ) {
    try {
      const { spaceId, pageId } = this.resolveCoordinates(
        routeSpaceId,
        paramPageId,
        paramDocId,
        queryPageId,
        resolvedSpace,
        req,
      );
      const versions = await this.historyService.listVersions(spaceId, pageId);
      const events = versions.map((v) => ({
        id: v.id,
        version: v.version,
        label: v.labels?.[0]?.label || v.summary || `Version ${v.version}`,
        createdAt: v.createdAt,
        userId: v.createdById || 'anonymous',
        summary: v.summary,
      }));
      return { events, history: events, versions };
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('versions')
  @ApiOperation({
    summary: 'List all historical snapshot versions and labels for project',
  })
  @ApiResponse({ status: 200, type: [VersionListItemDto] })
  async listVersions(
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<VersionListItemDto[]> {
    try {
      const { spaceId, pageId } = this.resolveCoordinates(
        routeSpaceId,
        paramPageId,
        paramDocId,
        queryPageId,
        resolvedSpace,
        req,
      );
      return await this.historyService.listVersions(spaceId, pageId);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('snapshots')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({
    summary: 'Manually capture an immutable snapshot of current project files',
  })
  @ApiResponse({ status: 201, type: SnapshotDetailDto })
  async createSnapshot(
    @Body() dto: CreateSnapshotDto,
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<SnapshotDetailDto> {
    try {
      const userId =
        req?.user?.sub || req?.user?.id || req?.user?.userId || null;
      const { spaceId, pageId } = this.resolveCoordinates(
        routeSpaceId,
        paramPageId,
        paramDocId,
        queryPageId ?? dto?.pageId,
        resolvedSpace,
        req,
      );
      return await this.historyService.createSnapshot(
        spaceId,
        dto,
        userId,
        pageId,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('versions/:version')
  @ApiOperation({
    summary:
      'Get full project file tree and content snapshot for a specific version',
  })
  @ApiResponse({ status: 200, type: SnapshotDetailDto })
  async getSnapshot(
    @Param('version', ParseIntPipe) version: number,
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<SnapshotDetailDto> {
    try {
      const { spaceId, pageId } = this.resolveCoordinates(
        routeSpaceId,
        paramPageId,
        paramDocId,
        queryPageId,
        resolvedSpace,
        req,
      );
      return await this.historyService.getSnapshot(spaceId, version, pageId);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('diff')
  @ApiOperation({
    summary:
      'Compute Myers line diffs and word highlights between two versions',
  })
  @ApiResponse({ status: 200, type: DiffResponseDto })
  async compareVersions(
    @Query() query: DiffQueryDto,
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<DiffResponseDto> {
    try {
      const { spaceId, pageId } = this.resolveCoordinates(
        routeSpaceId,
        paramPageId,
        paramDocId,
        queryPageId,
        resolvedSpace,
        req,
      );
      return await this.historyService.compareVersions(
        spaceId,
        query.baseVersion,
        query.targetVersion,
        pageId,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('versions/:version/labels')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({
    summary:
      'Attach or update a named label/milestone tag on a specific version',
  })
  @ApiResponse({ status: 201, type: VersionLabelDto })
  async labelVersion(
    @Param('version', ParseIntPipe) version: number,
    @Body() dto: LabelVersionDto,
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<VersionLabelDto> {
    try {
      const userId =
        req?.user?.sub || req?.user?.id || req?.user?.userId || null;
      const { spaceId, pageId } = this.resolveCoordinates(
        routeSpaceId,
        paramPageId,
        paramDocId,
        queryPageId ?? dto?.pageId,
        resolvedSpace,
        req,
      );
      return await this.historyService.labelVersion(
        spaceId,
        version,
        dto.label,
        userId,
        pageId,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Delete('labels/:labelId')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a named label from project history' })
  @ApiResponse({ status: 204 })
  async deleteLabel(
    @Param('labelId') labelId: string,
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<void> {
    try {
      const { spaceId, pageId } = this.resolveCoordinates(
        routeSpaceId,
        paramPageId,
        paramDocId,
        queryPageId,
        resolvedSpace,
        req,
      );
      await this.historyService.deleteLabel(spaceId, labelId, pageId);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('restore')
  @RequireRole(Role.COORDINATOR)
  @ApiOperation({
    summary:
      'Rollback project to a historical version (creates version N+1 non-destructively)',
  })
  @ApiResponse({ status: 200 })
  async restoreVersion(
    @Body() dto: RestoreVersionDto,
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ) {
    try {
      const userId =
        req?.user?.sub || req?.user?.id || req?.user?.userId || null;
      const { spaceId, pageId } = this.resolveCoordinates(
        routeSpaceId,
        paramPageId,
        paramDocId,
        queryPageId ?? dto?.pageId,
        resolvedSpace,
        req,
      );
      return await this.historyService.restoreVersion(
        spaceId,
        dto.targetVersion,
        userId,
        pageId,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('versions/:version/restore-file')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Atomically restore a single file from a historical version snapshot and record a new snapshot',
  })
  @ApiResponse({ status: 200, type: RestoreSingleFileResponseDto })
  async restoreSingleFile(
    @Param('version', ParseIntPipe) version: number,
    @Body() dto: RestoreSingleFileDto,
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<RestoreSingleFileResponseDto> {
    try {
      const userId =
        req?.user?.sub || req?.user?.id || req?.user?.userId || null;
      const { spaceId, pageId } = this.resolveCoordinates(
        routeSpaceId,
        paramPageId,
        paramDocId,
        queryPageId ?? dto?.pageId,
        resolvedSpace,
        req,
      );
      return await this.historyService.restoreSingleFile(
        spaceId,
        version,
        dto,
        userId,
        pageId,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('versions/:version/export-zip')
  @RequireRole(Role.REVIEWER)
  @ApiOperation({
    summary: 'Export historical version snapshot as a streaming PKZIP archive',
  })
  async exportVersionZip(
    @Param('version', ParseIntPipe) version: number,
    @Query('projectName') projectName: string | undefined,
    @Res() res: FastifyReply,
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<void> {
    try {
      const { spaceId, pageId } = this.resolveCoordinates(
        routeSpaceId,
        paramPageId,
        paramDocId,
        queryPageId,
        resolvedSpace,
        req,
      );
      const result = await this.historyService.exportVersionZipStream(
        spaceId,
        version,
        projectName,
        pageId,
      );

      res.header('Content-Type', 'application/zip');
      res.header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(result.filename)}"`,
      );

      if ('raw' in res && Boolean((res as unknown as { raw?: unknown }).raw)) {
        return res.send(result.zipStream);
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of result.zipStream) {
          chunks.push(Buffer.from(chunk));
        }
        const fullBuffer = Buffer.concat(chunks);
        res.header('Content-Length', fullBuffer.length.toString());
        return res.send(fullBuffer);
      }
    } catch (err) {
      this.handleError(err);
    }
  }
}
