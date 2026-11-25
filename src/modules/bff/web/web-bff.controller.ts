/**
 * modules/bff/web/web-bff.controller.ts
 * Subsystem 1 (Auth & Access Boundary):
 * Thin Web-channel BFF controller exposing screen-oriented aggregation routes.
 */

import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser, JwtAuthGuard } from '@/modules/identity/auth';
import {
  CurrentAccessContext,
  MemberAccessContext,
  ProjectAccessGuard,
  ProjectRoles,
  RequireRole,
  ResolvedSpace,
  Role,
} from '@/modules/project/access';
import { WebBffService } from './web-bff.service';
import type { BffEnvelope } from '../core/bff.types';
import type {
  WebEditorBootstrapData,
  WebProjectBootstrapData,
  WebWorkspaceShellData,
} from './web-bff.types';

@ApiTags('BFF - Web')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('api/v1/bff/web')
export class WebBffController {
  constructor(private readonly webBffService: WebBffService) {}

  @Get('workspace-shell')
  @ApiOperation({
    summary:
      'Hydrate Web workspace shell (projects, your-work summary, chat unread counters) in one request',
  })
  @ApiQuery({
    name: 'refresh',
    required: false,
    description: 'Set to "true" to bypass the short-TTL BFF channel cache',
  })
  @ApiResponse({
    status: 200,
    description:
      'Aggregated Web workspace shell payload with resilience & cache metadata',
  })
  getWorkspaceShell(
    @CurrentUser('id') userId: string,
    @Query('refresh') refresh?: string,
  ): Promise<BffEnvelope<WebWorkspaceShellData>> {
    return this.webBffService.getWorkspaceShell(userId, {
      bypassCache: refresh === 'true',
    });
  }

  @Get('projects/:projectId/bootstrap')
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary:
      'Hydrate Web project screen (project overview + shaped project chat channels) in one request',
  })
  @ApiParam({
    name: 'projectId',
    description: 'Project UUID',
  })
  @ApiQuery({
    name: 'refresh',
    required: false,
    description: 'Set to "true" to bypass the short-TTL BFF channel cache',
  })
  @ApiResponse({
    status: 200,
    description:
      'Aggregated Web project bootstrap payload with resilience & cache metadata',
  })
  getProjectBootstrap(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Query('refresh') refresh?: string,
  ): Promise<BffEnvelope<WebProjectBootstrapData>> {
    return this.webBffService.getProjectBootstrap(projectId, userId, {
      bypassCache: refresh === 'true',
    });
  }

  @Get('pages/:pageId/editor-bootstrap')
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.REVIEWER)
  @ApiOperation({
    summary:
      'Hydrate Web LaTeX/Docs editor (tree, active doc, last build metadata) under the standardized BFF envelope',
  })
  @ApiParam({
    name: 'pageId',
    description: 'Page or Project UUID',
  })
  @ApiQuery({
    name: 'fileId',
    required: false,
    description: 'Optional active file node UUID to hydrate',
  })
  @ApiResponse({
    status: 200,
    description: 'Editor bootstrap payload wrapped in standard BFF envelope',
  })
  getEditorBootstrap(
    @Param('pageId') pageId: string,
    @Query('fileId') fileId?: string,
    @CurrentUser('id') userId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string } | null,
    @CurrentAccessContext() accessCtx?: MemberAccessContext | null,
  ): Promise<BffEnvelope<WebEditorBootstrapData>> {
    return this.webBffService.getEditorBootstrap({
      pageOrProjectId: pageId,
      userId: userId || '',
      requestedFileId: fileId,
      authorizedProjectId: resolvedSpace,
      role: accessCtx?.role ?? null,
    });
  }
}
