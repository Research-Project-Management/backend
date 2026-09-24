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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
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
import { VersionNotFoundException } from './core/domain/exceptions/version-not-found.exception';
import { DuplicateLabelException } from './core/domain/exceptions/duplicate-label.exception';
import { EmptyProjectException } from './core/domain/exceptions/empty-project.exception';

@ApiTags('Manuscripts - Project History & Snapshots')
@Controller([
  'api/v1/manuscripts/projects/:projectId/history',
  'manuscripts/projects/:projectId/history',
  'projects/:projectId/history',
])
export class ProjectHistoryController {
  constructor(private readonly historyService: ProjectHistoryService) {}

  private handleError(error: any): never {
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

  @Get('versions')
  @ApiOperation({ summary: 'List all historical snapshot versions and labels for project' })
  @ApiResponse({ status: 200, type: [VersionListItemDto] })
  async listVersions(@Param('projectId') projectId: string): Promise<VersionListItemDto[]> {
    try {
      return await this.historyService.listVersions(projectId);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('snapshots')
  @ApiOperation({ summary: 'Manually capture an immutable snapshot of current project files' })
  @ApiResponse({ status: 201, type: SnapshotDetailDto })
  async createSnapshot(
    @Param('projectId') projectId: string,
    @Body() dto: CreateSnapshotDto,
  ): Promise<SnapshotDetailDto> {
    try {
      return await this.historyService.createSnapshot(projectId, dto);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('versions/:version')
  @ApiOperation({ summary: 'Get full project file tree and content snapshot for a specific version' })
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
  @ApiOperation({ summary: 'Compute Myers line diffs and word highlights between two versions' })
  @ApiResponse({ status: 200, type: DiffResponseDto })
  async compareVersions(
    @Param('projectId') projectId: string,
    @Query() query: DiffQueryDto,
  ): Promise<DiffResponseDto> {
    try {
      return await this.historyService.compareVersions(projectId, query.baseVersion, query.targetVersion);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('versions/:version/labels')
  @ApiOperation({ summary: 'Attach or update a named label/milestone tag on a specific version' })
  @ApiResponse({ status: 201, type: VersionLabelDto })
  async labelVersion(
    @Param('projectId') projectId: string,
    @Param('version', ParseIntPipe) version: number,
    @Body() dto: LabelVersionDto,
  ): Promise<VersionLabelDto> {
    try {
      return await this.historyService.labelVersion(projectId, version, dto.label);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Delete('labels/:labelId')
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
  @ApiOperation({ summary: 'Rollback project to a historical version (creates version N+1 non-destructively)' })
  @ApiResponse({ status: 200 })
  async restoreVersion(
    @Param('projectId') projectId: string,
    @Body() dto: RestoreVersionDto,
  ) {
    try {
      return await this.historyService.restoreVersion(projectId, dto.targetVersion);
    } catch (err) {
      this.handleError(err);
    }
  }
}
