import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  BadRequestException,
  UseGuards,
  HttpCode,
  HttpStatus,
  Optional,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import { HistoryService } from './history.service';
import { HistoryOpLogService } from './history-oplog.service';
import {
  CreateVersionDto,
  UpdateVersionDto,
  VersionQueryDto,
} from './dto/history.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

@ApiTags('Document - History & Versions')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class HistoryController {
  constructor(
    private readonly historyService: HistoryService,
    @Optional() private readonly opLogService?: HistoryOpLogService,
  ) {}

  @Get(['pages/:pageId/versions', 'projects/:projectId/pages/:pageId/versions'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'List all versions of a page (supports pagination)',
  })
  async getVersions(
    @Param('pageId') pageId: string,
    @Query() query: VersionQueryDto,
  ) {
    return this.historyService.getVersions(pageId, query);
  }

  @Get([
    'pages/:pageId/versions/:versionId',
    'projects/:projectId/pages/:pageId/versions/:versionId',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get single version snapshot with content' })
  async getVersion(
    @Param('pageId') pageId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.historyService.getVersion(pageId, versionId);
  }

  @Patch([
    'pages/:pageId/versions/:versionId',
    'projects/:projectId/pages/:pageId/versions/:versionId',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update version label or milestone name' })
  async updateVersion(
    @Param('pageId') pageId: string,
    @Param('versionId') versionId: string,
    @Body() dto: UpdateVersionDto,
  ) {
    return this.historyService.updateVersion(pageId, versionId, dto);
  }

  @Post([
    'pages/:pageId/versions',
    'projects/:projectId/pages/:pageId/versions',
  ])
  @HttpCode(HttpStatus.CREATED)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Save a new version snapshot of a page' })
  async createVersion(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateVersionDto,
  ) {
    return this.historyService.createVersion(pageId, userId, dto);
  }

  @Post([
    'pages/:pageId/versions/:versionId/restore',
    'projects/:projectId/pages/:pageId/versions/:versionId/restore',
  ])
  @HttpCode(HttpStatus.OK)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Restore page content to a specific version (Collaborative)',
  })
  async restoreVersion(
    @Param('pageId') pageId: string,
    @Param('versionId') versionId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.historyService.restoreVersion(pageId, versionId, userId);
  }

  @Delete([
    'pages/:pageId/versions/:versionId',
    'projects/:projectId/pages/:pageId/versions/:versionId',
  ])
  @ProjectRoles('owner')
  async deleteVersion(
    @Param('pageId') pageId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.historyService.deleteVersion(versionId, pageId);
  }

  @Get([
    'pages/:pageId/history',
    'projects/:projectId/pages/:pageId/history',
    'projects/:projectId/history',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get change history (activity log) for a page or project',
  })
  async getHistory(
    @Param('pageId') pageId?: string,
    @Param('projectId') projectId?: string,
  ) {
    const id = pageId || projectId;
    return this.historyService.getHistory(id!);
  }

  @Post([
    'pages/:pageId/history/:eventId/restore',
    'projects/:projectId/pages/:pageId/history/:eventId/restore',
  ])
  @HttpCode(HttpStatus.OK)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Restore page to a specific history event state' })
  async restoreHistoryEvent(
    @Param('pageId') pageId: string,
    @Param('eventId') eventId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.historyService.restoreVersion(pageId, eventId, userId);
  }

  @Get([
    'pages/:pageId/versions/diff',
    'projects/:projectId/pages/:pageId/versions/diff',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Compute line-by-line visual diff between two version snapshots',
  })
  async compareVersions(
    @Param('pageId') pageId: string,
    @Query('from') fromVersionId: string,
    @Query('to') toVersionId: string,
  ) {
    if (!fromVersionId || !toVersionId) {
      throw new BadRequestException(
        'Both "from" and "to" version IDs are required to compute diff',
      );
    }
    return this.historyService.compareVersions(
      pageId,
      fromVersionId,
      toVersionId,
    );
  }

  // ─── Op Log Endpoints (Overleaf-style keystroke-level history) ───────────────

  @Get(['pages/:pageId/timeline', 'projects/:projectId/pages/:pageId/timeline'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary:
      'Get keystroke-level op log timeline metadata for time-machine scrubbing',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'ISO 8601 start timestamp',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'ISO 8601 end timestamp',
  })
  async getTimeline(
    @Param('pageId') pageId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!this.opLogService) {
      return {
        pageId,
        entries: [],
        totalOps: 0,
        oldestMs: null,
        newestMs: null,
      };
    }
    const fromMs = from ? new Date(from).getTime() : undefined;
    const toMs = to ? new Date(to).getTime() : undefined;
    if (from && isNaN(fromMs!))
      throw new BadRequestException('Invalid "from" timestamp');
    if (to && isNaN(toMs!))
      throw new BadRequestException('Invalid "to" timestamp');
    return this.opLogService.getTimeline(pageId, fromMs, toMs);
  }

  @Get(['pages/:pageId/at', 'projects/:projectId/pages/:pageId/at'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary:
      'Reconstruct document content at a specific point in time (time-machine)',
  })
  @ApiQuery({
    name: 't',
    required: true,
    description: 'ISO 8601 target timestamp',
  })
  async getContentAt(@Param('pageId') pageId: string, @Query('t') t: string) {
    if (!t)
      throw new BadRequestException(
        'Query param "t" (ISO timestamp) is required',
      );
    const targetMs = new Date(t).getTime();
    if (isNaN(targetMs)) throw new BadRequestException('Invalid timestamp "t"');

    if (!this.opLogService) {
      return { pageId, content: '', targetMs, source: 'unavailable' };
    }

    const content = await this.opLogService.replayToPoint(pageId, targetMs);
    return {
      pageId,
      content,
      targetMs,
      reconstructedAt: new Date(targetMs).toISOString(),
    };
  }
}
