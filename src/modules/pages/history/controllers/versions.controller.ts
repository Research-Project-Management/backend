/**
 * history/controllers/versions.controller.ts
 * Canonical REST API Controller for Document-scoped Version History, Diff, Timeline & Point-in-time reads.
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
import { VersionsService } from '../services/versions.service';

@ApiTags('Pages - Document Versions')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages/docs/:docId')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class VersionsController {
  constructor(private readonly versionsService: VersionsService) {}

  @Get('versions')
  async getVersions(
    @Param('docId') docId: string,
    @ResolvedSpace() space?: string | { id: string } | null,
  ) {
    return this.versionsService.getVersions(docId, space);
  }

  @Get('versions/diff')
  async getDiff(
    @Param('docId') docId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @ResolvedSpace() space?: string | { id: string } | null,
  ) {
    return this.versionsService.getDiff(docId, from, to, space);
  }

  @Get('versions/:versionId')
  async getVersionById(
    @Param('docId') docId: string,
    @Param('versionId') versionId: string,
    @ResolvedSpace() space?: string | { id: string } | null,
  ) {
    return this.versionsService.getVersionById(docId, versionId, space);
  }

  @Post('versions')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.CREATED)
  async createVersion(
    @Param('docId') docId: string,
    @Body() body: { label?: string; content?: string },
    @Req() req: AuthenticatedRequest,
    @ResolvedSpace() space?: string | { id: string } | null,
  ) {
    return this.versionsService.createVersion(docId, body, req, space);
  }

  @Post('versions/:versionId/restore')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async restoreVersion(
    @Param('docId') docId: string,
    @Param('versionId') versionId: string,
    @ResolvedSpace() space?: string | { id: string } | null,
    @CurrentUser('id') userId?: string,
  ) {
    return this.versionsService.restoreVersion(docId, versionId, space, userId);
  }

  @Post('versions/:versionId/label')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async labelVersion(
    @Param('versionId') versionId: string,
    @Body() body: { label: string; title?: string },
    @Req() req: AuthenticatedRequest,
    @ResolvedSpace() space?: string | { id: string } | null,
  ) {
    return this.versionsService.labelVersion(versionId, body, req, space);
  }

  @Get('timeline')
  async getTimeline(
    @Param('docId') docId: string,
    @ResolvedSpace() space?: string | { id: string } | null,
  ) {
    return this.versionsService.getTimeline(docId, space);
  }

  @Get('at')
  async getAt(
    @Param('docId') docId: string,
    @Query('timestamp') timestamp?: string,
    @ResolvedSpace() space?: string | { id: string } | null,
  ) {
    return this.versionsService.getAt(docId, timestamp, space);
  }
}
