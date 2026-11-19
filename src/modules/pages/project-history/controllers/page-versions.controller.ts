/**
 * modules/pages/project-history/controllers/page-versions.controller.ts
 * Domain controller exposing version history, diff, label, timeline, and point-in-time endpoints.
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Req,
  HttpStatus,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  ResolvedSpace,
} from '@/modules/project/access';
import { AuthenticatedRequest } from '@/core';
import { PageVersionsService } from '../services/page-versions.service';

@ApiTags('Manuscripts - Pages History & Export')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class PageVersionsController {
  constructor(private readonly pageVersionsService: PageVersionsService) {}

  @Get(['pages/:pageId/versions', 'docs/:pageId/versions'])
  async getVersions(
    @Param('pageId') pageId: string,
    @ResolvedSpace() project?: string | { id: string } | null,
  ) {
    return this.pageVersionsService.getVersions(pageId, project);
  }

  @Get([
    'pages/:pageId/versions/diff',
    'pages/:pageId/diff',
    'docs/:pageId/versions/diff',
    'docs/:pageId/diff',
  ])
  async getDiff(
    @Param('pageId') pageId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @ResolvedSpace() project?: string | { id: string } | null,
  ) {
    return this.pageVersionsService.getDiff(pageId, from, to, project);
  }

  @Get([
    'pages/:pageId/versions/:versionId',
    'docs/:pageId/versions/:versionId',
  ])
  async getVersionById(
    @Param('pageId') pageId: string,
    @Param('versionId') versionId: string,
    @ResolvedSpace() project?: string | { id: string } | null,
  ) {
    return this.pageVersionsService.getVersionById(pageId, versionId, project);
  }

  @Post(['pages/:pageId/versions', 'docs/:pageId/versions'])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.CREATED)
  async createVersion(
    @Param('pageId') pageId: string,
    @Body() body: { label?: string; content?: string },
    @Req() req: AuthenticatedRequest,
    @ResolvedSpace() project?: string | { id: string } | null,
  ) {
    return this.pageVersionsService.createVersion(pageId, body, req, project);
  }

  @Post([
    'pages/:pageId/versions/:versionId/restore',
    'docs/:pageId/versions/:versionId/restore',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async restoreVersion(
    @Param('pageId') pageId: string,
    @Param('versionId') versionId: string,
    @ResolvedSpace() project?: string | { id: string } | null,
    @CurrentUser('id') userId?: string,
  ) {
    return this.pageVersionsService.restoreVersion(
      pageId,
      versionId,
      project,
      userId,
    );
  }

  @Post([
    'pages/:pageId/versions/:versionId/label',
    'docs/:pageId/versions/:versionId/label',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async labelVersion(
    @Param('versionId') versionId: string,
    @Body() body: { label: string; title?: string },
    @Req() req: AuthenticatedRequest,
    @ResolvedSpace() project?: string | { id: string } | null,
  ) {
    return this.pageVersionsService.labelVersion(versionId, body, req, project);
  }

  @Get(['pages/:pageId/timeline', 'docs/:pageId/timeline'])
  async getTimeline(
    @Param('pageId') pageId: string,
    @ResolvedSpace() project?: string | { id: string } | null,
  ) {
    return this.pageVersionsService.getTimeline(pageId, project);
  }

  @Get(['pages/:pageId/at', 'docs/:pageId/at'])
  async getAt(
    @Param('pageId') pageId: string,
    @Query('timestamp') timestamp?: string,
    @ResolvedSpace() project?: string | { id: string } | null,
  ) {
    return this.pageVersionsService.getAt(pageId, timestamp, project);
  }
}
