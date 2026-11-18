/**
 * modules/pages/bootstrap/editor-bootstrap.controller.ts
 * Thin BFF controller exposing the single-round-trip Editor Bootstrap endpoint.
 */

import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtAuthGuard } from '@/modules/identity/auth';
import {
  CurrentAccessContext,
  MemberAccessContext,
  ProjectAccessGuard,
  RequireRole,
  ResolvedSpace,
  Role,
} from '@/modules/project/access';
import { EditorBootstrapService } from './editor-bootstrap.service';
import type { EditorBootstrapResponseDto } from './editor-bootstrap.types';

@ApiTags('Pages - Editor Bootstrap BFF')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class EditorBootstrapController {
  constructor(
    private readonly editorBootstrapService: EditorBootstrapService,
  ) {}

  @Get([
    'pages/:pageId/bootstrap',
    'docs/:pageId/bootstrap',
    'spaces/:spaceId/bootstrap',
  ])
  @ApiOperation({
    summary:
      'Hydrate all 3 Editor blocks (tree/symbols, workspace/activeDoc, lastBuild metadata) in a single HTTP request',
  })
  async getEditorBootstrap(
    @Param('pageId') pageId?: string,
    @Param('spaceId') spaceId?: string,
    @Query('fileId') fileId?: string,
    @Query('file') fileAlias?: string,
    @CurrentUser('id') userId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string } | null,
    @CurrentAccessContext() accessCtx?: MemberAccessContext | null,
  ): Promise<EditorBootstrapResponseDto> {
    return this.editorBootstrapService.bootstrapEditor({
      pageOrProjectId: pageId || spaceId || '',
      userId: userId || '',
      requestedFileId: fileId || fileAlias,
      authorizedProjectId: resolvedSpace,
      role: accessCtx?.role ?? null,
    });
  }
}
