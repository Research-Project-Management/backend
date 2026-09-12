import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
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

  @Get([
    'projects/:projectId/pages/:pageId/versions',
    'project/:projectId/pages/:pageId/versions',
    'pages/:pageId/versions',
  ])
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'List all versions of a page' })
  async getVersions(@Param('pageId') pageId: string) {
    return this.historyService.getVersions(pageId);
  }

  @Post([
    'projects/:projectId/pages/:pageId/versions',
    'project/:projectId/pages/:pageId/versions',
    'pages/:pageId/versions',
  ])
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
    'projects/:projectId/pages/:pageId/versions/:versionId/restore',
    'project/:projectId/pages/:pageId/versions/:versionId/restore',
    'pages/:pageId/versions/:versionId/restore',
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
    'projects/:projectId/pages/:pageId/versions/:versionId',
    'project/:projectId/pages/:pageId/versions/:versionId',
    'pages/:pageId/versions/:versionId',
  ])
  @ProjectRoles('owner')
  async deleteVersion(
    @Param('versionId') versionId: string,
    @Param('pageId') pageId?: string,
  ) {
    return this.historyService.deleteVersion(versionId, pageId);
  }

  @Get([
    'projects/:projectId/pages/:pageId/history',
    'project/:projectId/pages/:pageId/history',
    'pages/:pageId/history',
  ])
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get change history (activity log) for a page' })
  async getHistory(@Param('pageId') pageId: string) {
    return this.historyService.getHistory(pageId);
  }

  @Post([
    'projects/:projectId/pages/:pageId/history/:eventId/restore',
    'project/:projectId/pages/:pageId/history/:eventId/restore',
    'pages/:pageId/history/:eventId/restore',
  ])
  @HttpCode(HttpStatus.OK)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Restore page to a specific history event state' })
  async restoreHistory(
    @Param('pageId') pageId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.historyService.restoreVersion(pageId, eventId);
  }
}
