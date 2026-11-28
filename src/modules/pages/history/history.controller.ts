/**
 * history/history.controller.ts
 * Canonical REST API Controller for Space/Project History, Snapshots, Diff & Labels.
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
import {
  AuthenticatedRequest,
  UserRateLimit,
  UserRateLimitGuard,
} from '@/core';
import { resolvePageControllerCoordinates } from '@/modules/pages/core';
import { SnapshotService } from './services/snapshot.service';
import { DiffService } from './services/diff.service';
import { LabelService } from './services/label.service';
import { RestoreService } from './services/restore.service';
import {
  CreateSnapshotDto,
  SnapshotDetailDto,
  VersionListItemDto,
} from './dto/snapshot.dto';
import { LabelVersionDto, VersionLabelDto } from './dto/label.dto';
import {
  RestoreVersionDto,
  RestoreSingleFileDto,
  RestoreSingleFileResponseDto,
} from './dto/restore.dto';
import { DiffQueryDto, DiffResponseDto } from './dto/diff.dto';

@ApiTags('Pages - History & Snapshots')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages/spaces/:spaceId/history')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class HistoryController {
  constructor(
    private readonly snapshots: SnapshotService,
    private readonly diff: DiffService,
    private readonly labels: LabelService,
    private readonly restore: RestoreService,
  ) {}

  private resolveCoordinates(
    routeSpaceId: string,
    resolvedSpace?: string | { id?: string } | null,
    explicitPageId?: string,
    req?: AuthenticatedRequest,
  ): { spaceId: string; pageId?: string } {
    return resolvePageControllerCoordinates(
      { spaceId: routeSpaceId },
      resolvedSpace,
      explicitPageId,
      req,
    );
  }

  private resolveUserId(req?: AuthenticatedRequest): string | null {
    return req?.user?.sub || req?.user?.id || req?.user?.userId || null;
  }

  @Get('versions')
  @ApiOperation({
    summary: 'List all historical snapshot versions and labels',
  })
  @ApiResponse({ status: 200, type: [VersionListItemDto] })
  async listVersions(
    @Param('spaceId') routeSpaceId: string,
    @Query('pageId') pageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<VersionListItemDto[]> {
    const coords = this.resolveCoordinates(
      routeSpaceId,
      resolvedSpace,
      pageId,
      req,
    );
    return await this.snapshots.listVersions(coords.spaceId, coords.pageId);
  }

  @Post('snapshots')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({
    summary: 'Manually capture an immutable snapshot of current files',
  })
  @ApiResponse({ status: 201, type: SnapshotDetailDto })
  async createSnapshot(
    @Param('spaceId') routeSpaceId: string,
    @Body() dto: CreateSnapshotDto,
    @Query('pageId') pageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<SnapshotDetailDto> {
    const coords = this.resolveCoordinates(
      routeSpaceId,
      resolvedSpace,
      pageId ?? dto.pageId,
      req,
    );
    return await this.snapshots.createSnapshot(
      coords.spaceId,
      dto,
      this.resolveUserId(req),
      coords.pageId,
    );
  }

  @Get('versions/:version')
  @ApiOperation({
    summary: 'Get full file tree and content snapshot for a specific version',
  })
  @ApiResponse({ status: 200, type: SnapshotDetailDto })
  async getSnapshot(
    @Param('spaceId') routeSpaceId: string,
    @Param('version', ParseIntPipe) version: number,
    @Query('pageId') pageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<SnapshotDetailDto> {
    const coords = this.resolveCoordinates(
      routeSpaceId,
      resolvedSpace,
      pageId,
      req,
    );
    return await this.snapshots.getSnapshot(
      coords.spaceId,
      version,
      coords.pageId,
    );
  }

  @Get('diff')
  @ApiOperation({
    summary: 'Compute Myers line diffs and word highlights between two versions',
  })
  @ApiResponse({ status: 200, type: DiffResponseDto })
  async compareVersions(
    @Param('spaceId') routeSpaceId: string,
    @Query() query: DiffQueryDto,
    @Query('pageId') pageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<DiffResponseDto> {
    const coords = this.resolveCoordinates(
      routeSpaceId,
      resolvedSpace,
      pageId,
      req,
    );
    return await this.diff.compareVersions(
      coords.spaceId,
      query.baseVersion,
      query.targetVersion,
      coords.pageId,
    );
  }

  @Post('versions/:version/labels')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({
    summary: 'Attach or update a named label/milestone tag on a version',
  })
  @ApiResponse({ status: 201, type: VersionLabelDto })
  async labelVersion(
    @Param('spaceId') routeSpaceId: string,
    @Param('version', ParseIntPipe) version: number,
    @Body() dto: LabelVersionDto,
    @Query('pageId') pageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<VersionLabelDto> {
    const coords = this.resolveCoordinates(
      routeSpaceId,
      resolvedSpace,
      pageId ?? dto.pageId,
      req,
    );
    return await this.labels.labelVersion(
      coords.spaceId,
      version,
      dto.label,
      this.resolveUserId(req),
      coords.pageId,
    );
  }

  @Delete('labels/:labelId')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a named label from history' })
  @ApiResponse({ status: 204 })
  async deleteLabel(
    @Param('spaceId') routeSpaceId: string,
    @Param('labelId') labelId: string,
    @Query('pageId') pageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<void> {
    const coords = this.resolveCoordinates(
      routeSpaceId,
      resolvedSpace,
      pageId,
      req,
    );
    await this.labels.deleteLabel(coords.spaceId, labelId, coords.pageId);
  }

  @Post('restore')
  @RequireRole(Role.COORDINATOR)
  @ApiOperation({
    summary:
      'Rollback to a historical version (creates version N+1 non-destructively)',
  })
  @ApiResponse({ status: 200 })
  async restoreVersion(
    @Param('spaceId') routeSpaceId: string,
    @Body() dto: RestoreVersionDto,
    @Query('pageId') pageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ) {
    const coords = this.resolveCoordinates(
      routeSpaceId,
      resolvedSpace,
      pageId ?? dto.pageId,
      req,
    );
    return await this.restore.restoreVersion(
      coords.spaceId,
      dto.targetVersion,
      this.resolveUserId(req),
      coords.pageId,
    );
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
    @Param('spaceId') routeSpaceId: string,
    @Param('version', ParseIntPipe) version: number,
    @Body() dto: RestoreSingleFileDto,
    @Query('pageId') pageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<RestoreSingleFileResponseDto> {
    const coords = this.resolveCoordinates(
      routeSpaceId,
      resolvedSpace,
      pageId ?? dto.pageId,
      req,
    );
    return await this.restore.restoreSingleFile(
      coords.spaceId,
      version,
      dto,
      this.resolveUserId(req),
      coords.pageId,
    );
  }

  @Get('labels')
  @ApiOperation({ summary: 'List all named milestone labels in history' })
  @ApiResponse({ status: 200, type: [VersionLabelDto] })
  async listLabels(
    @Param('spaceId') routeSpaceId: string,
    @Query('pageId') pageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<VersionLabelDto[]> {
    const coords = this.resolveCoordinates(
      routeSpaceId,
      resolvedSpace,
      pageId,
      req,
    );
    return await this.labels.listLabels(coords.spaceId, coords.pageId);
  }

  @Get('blobs/:contentHash')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit('files-download')
  @ApiOperation({
    summary: 'Fetch a content-addressable historical file blob by SHA-256 hash',
  })
  async getBlob(
    @Param('spaceId') routeSpaceId: string,
    @Param('contentHash') contentHash: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ) {
    const { spaceId } = this.resolveCoordinates(
      routeSpaceId,
      resolvedSpace,
      undefined,
      req,
    );
    return await this.snapshots.getBlob(spaceId, contentHash);
  }

  @Post('flush')
  @RequireRole(Role.CONTRIBUTOR)
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit('default')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Flush live Yjs collaboration changes into history if modified since latest snapshot',
  })
  async flushHistory(
    @Param('spaceId') routeSpaceId: string,
    @Query('pageId') pageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ) {
    const coords = this.resolveCoordinates(
      routeSpaceId,
      resolvedSpace,
      pageId,
      req,
    );
    return await this.snapshots.flushHistory(
      coords.spaceId,
      this.resolveUserId(req),
      coords.pageId,
    );
  }

  @Get('versions/:version/export-zip')
  @RequireRole(Role.REVIEWER)
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit('files-download')
  @ApiOperation({
    summary: 'Export historical version snapshot as a streaming PKZIP archive',
  })
  async exportVersionZip(
    @Param('spaceId') routeSpaceId: string,
    @Param('version', ParseIntPipe) version: number,
    @Query('projectName') projectName: string | undefined,
    @Res() res: FastifyReply,
    @Query('pageId') pageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<void> {
    const coords = this.resolveCoordinates(
      routeSpaceId,
      resolvedSpace,
      pageId,
      req,
    );
    const result = await this.snapshots.exportVersionZipStream(
      coords.spaceId,
      version,
      projectName,
      coords.pageId,
    );

    res.header('Content-Type', 'application/zip');
    res.header(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(result.filename)}"`,
    );

    if ('raw' in res && Boolean(res.raw)) {
      return res.send(result.zipStream);
    }

    const chunks: Buffer[] = [];
    for await (const chunk of result.zipStream) {
      chunks.push(Buffer.from(chunk));
    }
    const fullBuffer = Buffer.concat(chunks);
    res.header('Content-Length', fullBuffer.length.toString());
    return res.send(fullBuffer);
  }
}
