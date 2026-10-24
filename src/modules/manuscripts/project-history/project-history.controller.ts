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
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { ProjectAccessGuard, RequireRole, Role } from '@/modules/project/access';
import { ProjectHistoryService } from './project-history.service';
import {
  CreateSnapshotDto,
  LabelVersionDto,
  RestoreVersionDto,
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
} from './domain';
import { AuthenticatedRequest } from '@/core';

@ApiTags('Manuscripts - Project History & Snapshots')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/manuscripts/projects/:projectId/history')
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
    if (error instanceof EmptyProjectException) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }

  @Get('')
  @ApiOperation({
    summary: 'Get project history events and versions overview',
  })
  async getProjectHistory(
    @Param('projectId') projectId: string,
  ) {
    try {
      const versions = await this.historyService.listVersions(projectId);
      const events = versions.map((v) => ({
        id: v.id,
        version: v.version,
        label: v.labels?.[0] || v.summary || `Version ${v.version}`,
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
    @Param('projectId') projectId: string,
  ): Promise<VersionListItemDto[]> {
    try {
      return await this.historyService.listVersions(projectId);
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
    @Param('projectId') projectId: string,
    @Body() dto: CreateSnapshotDto,
    @Req() req?: AuthenticatedRequest,
  ): Promise<SnapshotDetailDto> {
    try {
      const userId =
        req?.user?.sub || req?.user?.id || req?.user?.userId || null;
      return await this.historyService.createSnapshot(projectId, dto, userId);
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
    @Param('projectId') projectId: string,
    @Param('version', ParseIntPipe) version: number,
  ): Promise<SnapshotDetailDto> {
    try {
      return await this.historyService.getSnapshot(projectId, version);
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
    @Param('projectId') projectId: string,
    @Query() query: DiffQueryDto,
  ): Promise<DiffResponseDto> {
    try {
      return await this.historyService.compareVersions(
        projectId,
        query.baseVersion,
        query.targetVersion,
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
    @Param('projectId') projectId: string,
    @Param('version', ParseIntPipe) version: number,
    @Body() dto: LabelVersionDto,
    @Req() req?: AuthenticatedRequest,
  ): Promise<VersionLabelDto> {
    try {
      const userId =
        req?.user?.sub || req?.user?.id || req?.user?.userId || null;
      return await this.historyService.labelVersion(
        projectId,
        version,
        dto.label,
        userId,
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
    @Param('projectId') projectId: string,
    @Param('labelId') labelId: string,
  ): Promise<void> {
    try {
      await this.historyService.deleteLabel(projectId, labelId);
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
    @Param('projectId') projectId: string,
    @Body() dto: RestoreVersionDto,
    @Req() req?: AuthenticatedRequest,
  ) {
    try {
      const userId =
        req?.user?.sub || req?.user?.id || req?.user?.userId || null;
      return await this.historyService.restoreVersion(
        projectId,
        dto.targetVersion,
        userId,
      );
    } catch (err) {
      this.handleError(err);
    }
  }
}
