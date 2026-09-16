import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  BadRequestException,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { HistoryService } from './history.service';
import { CreateVersionDto } from './dto/history.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

@ApiTags('Document - History & Versions')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class HistoryController {
  constructor(private readonly historyService: HistoryService) {}

  @Get(['pages/:pageId/versions', 'projects/:projectId/pages/:pageId/versions'])
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'List all versions of a page' })
  async getVersions(@Param('pageId') pageId: string) {
    return this.historyService.getVersions(pageId);
  }

  @Get([
    'pages/:pageId/versions/:versionId',
    'projects/:projectId/pages/:pageId/versions/:versionId',
  ])
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get single version snapshot with content' })
  async getVersion(
    @Param('pageId') pageId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.historyService.getVersion(pageId, versionId);
  }

  @Post(['pages/:pageId/versions', 'projects/:projectId/pages/:pageId/versions'])
  @HttpCode(HttpStatus.CREATED)
  @ProjectRoles('owner', 'contributor')
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
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Restore page content to a specific version' })
  async restoreVersion(
    @Param('pageId') pageId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.historyService.restoreVersion(pageId, versionId);
  }

  @Delete([
    'pages/:pageId/versions/:versionId',
    'projects/:projectId/pages/:pageId/versions/:versionId',
  ])
  @ProjectRoles('owner')
  async deleteVersion(
    @Param('versionId') versionId: string,
    @Param('pageId') pageId?: string,
  ) {
    return this.historyService.deleteVersion(versionId, pageId);
  }

  @Get(['pages/:pageId/history', 'projects/:projectId/pages/:pageId/history'])
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get change history (activity log) for a page' })
  async getHistory(@Param('pageId') pageId: string) {
    return this.historyService.getHistory(pageId);
  }

  @Post([
    'pages/:pageId/history/:eventId/restore',
    'projects/:projectId/pages/:pageId/history/:eventId/restore',
  ])
  @HttpCode(HttpStatus.OK)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Restore page to a specific history event state' })
  async restoreHistoryEvent(
    @Param('pageId') pageId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.historyService.restoreVersion(pageId, eventId);
  }

  @Get([
    'pages/:pageId/versions/diff',
    'projects/:projectId/pages/:pageId/versions/diff',
  ])
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
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
}
