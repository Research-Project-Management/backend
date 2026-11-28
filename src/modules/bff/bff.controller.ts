/**
 * modules/bff/bff.controller.ts
 * Canonical Web BFF routes (/api/v1/bff/web/*).
 * Uses @BypassEnvelope() so the wire format is directly BffEnvelope<T> ({ data, meta })
 * without redundant TransformInterceptor double-wrapping.
 */

import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { BypassEnvelope } from '@/core/http/decorators/bypass.decorator';
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
import type { EditorBootstrapResponseDto } from '@/modules/pages';
import {
  BffService,
  type BffEnvelope,
  type WebProjectBootstrapData,
  type WebWorkspaceShellData,
} from './bff.service';

@ApiTags('BFF - Web')
@ApiBearerAuth('JWT-auth')
@BypassEnvelope()
@UseGuards(JwtAuthGuard)
@Controller('api/v1/bff/web')
export class BffController {
  constructor(private readonly bffService: BffService) {}

  @Get('workspace-shell')
  @ApiOperation({
    summary:
      'Hydrate Web workspace shell (normalized projects, your-work, chat unread summary)',
  })
  @ApiQuery({ name: 'refresh', required: false })
  getWorkspaceShell(
    @CurrentUser('id') userId: string,
    @Query('refresh') refresh?: string,
  ): Promise<BffEnvelope<WebWorkspaceShellData>> {
    return this.bffService.getWorkspaceShell(userId, {
      bypassCache: refresh === 'true',
    });
  }

  @Get('projects/:projectId/bootstrap')
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary:
      'Hydrate Web project screen (project overview + shaped chat channels)',
  })
  @ApiParam({ name: 'projectId', description: 'Project UUID' })
  @ApiQuery({ name: 'refresh', required: false })
  getProjectBootstrap(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Query('refresh') refresh?: string,
  ): Promise<BffEnvelope<WebProjectBootstrapData>> {
    return this.bffService.getProjectBootstrap(projectId, userId, {
      bypassCache: refresh === 'true',
    });
  }

  @Get([
    'pages/:pageId/editor-bootstrap',
    'projects/:projectId/editor-bootstrap',
  ])
  @UseGuards(ProjectAccessGuard)
  @RequireRole(Role.REVIEWER)
  @ApiOperation({
    summary:
      'Hydrate Web LaTeX/Docs editor (tree, active doc, last build metadata)',
  })
  @ApiQuery({ name: 'fileId', required: false })
  getEditorBootstrap(
    @Req() req: { resolvedPageId?: string },
    @Param('pageId') pageId?: string,
    @Param('projectId') projectId?: string,
    @Query('fileId') fileId?: string,
    @CurrentUser('id') userId?: string,
    @ResolvedSpace() resolvedSpace?: string | null,
    @CurrentAccessContext() accessCtx?: MemberAccessContext | null,
  ): Promise<BffEnvelope<EditorBootstrapResponseDto>> {
    return this.bffService.getEditorBootstrap({
      pageOrProjectId: req?.resolvedPageId || pageId || projectId || '',
      userId: userId || '',
      requestedFileId: fileId,
      authorizedProjectId: resolvedSpace,
      role: accessCtx?.role ?? null,
    });
  }
}
