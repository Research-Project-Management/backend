/**
 * modules/pages/docstore/controllers/doc-sync.controller.ts
 * Domain controller exposing incremental Yjs-to-Docstore flush/sync barriers for compilation.
 */

import {
  Controller,
  Post,
  Param,
  Body,
  HttpStatus,
  HttpCode,
  Inject,
  Optional,
  NotFoundException,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtAuthGuard } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  ResolvedSpace,
} from '@/modules/project/access';
import { isUuid } from '@/core';
import {
  getRecordSpaceId,
  resolveActiveProjectId,
} from '@/modules/pages/core/page-scope.helper';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
} from '@/modules/pages/core';
import { PageService } from '@/modules/pages/core/services/page.service';
import { DocstoreService } from '../docstore.service';
import { ScopeRepository } from '../repositories/scope.repository';

@ApiTags('Manuscripts - Pages History & Export')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class DocSyncController {
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    private readonly docstoreService: DocstoreService,
    private readonly pageScopeRepo: ScopeRepository,
    private readonly pageService: PageService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollabOrLegacyRef?: LiveCollaborationPort | unknown,
  ) {
    this.liveCollab =
      liveCollabOrLegacyRef &&
      typeof (liveCollabOrLegacyRef as LiveCollaborationPort)
        .applyExternalText === 'function'
        ? (liveCollabOrLegacyRef as LiveCollaborationPort)
        : NOOP_LIVE_COLLABORATION;
  }

  @Post([
    'pages/:rootPageId/sync-incremental',
    'docs/:rootPageId/sync-incremental',
    'spaces/:spaceId/sync-incremental',
    'spaces/:spaceId/docs/:rootPageId/sync-incremental',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async syncIncremental(
    @Param('rootPageId') rootPageId: string,
    @Body() body: { dirtyFileIds?: string[]; forceAll?: boolean },
    @Param('spaceId') routeSpaceId?: string,
    @ResolvedSpace() project?: string | { id: string } | null,
  ) {
    const effectiveTargetId = rootPageId || routeSpaceId;
    if (!effectiveTargetId || !isUuid(effectiveTargetId)) {
      throw new BadRequestException(
        'A valid UUID is required for sync-incremental',
      );
    }
    const activeProjectId = resolveActiveProjectId(project) || routeSpaceId;
    const doc = activeProjectId
      ? await this.pageScopeRepo.findDocInProject(
          activeProjectId,
          effectiveTargetId,
        )
      : null;
    const projectId =
      getRecordSpaceId(doc) ||
      activeProjectId ||
      (await this.pageService.resolveProjectId(effectiveTargetId));
    if (!projectId) {
      throw new NotFoundException(
        `Document/project ${effectiveTargetId} not found`,
      );
    }

    const targetPageId =
      (doc as { pageId?: string | null } | null)?.pageId ||
      (rootPageId && isUuid(rootPageId) && rootPageId !== projectId
        ? rootPageId
        : undefined);
    const requested = (body?.dirtyFileIds || []).filter((id) => isUuid(id));
    const allDocs = await this.docstoreService.getAllDocs(
      projectId,
      targetPageId,
    );
    const docs = body?.forceAll
      ? allDocs
      : allDocs.filter((d) => requested.includes(d.id || d._id));
    const docIds = docs.map((d) => d.id || d._id);

    const flushedLive = await this.liveCollab.flushDocs(projectId, docIds);

    if (this.eventEmitter) {
      this.eventEmitter.emit('manuscripts.project.event', {
        projectId,
        event: 'compiler:sync',
        payload: {
          rootPageId,
          dirtyFileIds: docIds,
          timestamp: Date.now(),
        },
      });
    }

    return {
      synced: docIds,
      total: docIds.length,
      rootPageId,
      projectId,
      flushedLiveSessions: flushedLive,
      rejected: requested.filter((id) => !docIds.includes(id)),
    };
  }

  @Post('spaces/:spaceId/updater/flush')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async flushProject(@Param('spaceId') spaceId: string) {
    const startedAt = Date.now();
    const flushed = await this.liveCollab.flushDocs(spaceId, []);
    return {
      spaceId,
      flushedDocs: flushed.length,
      flushedDocsCount: flushed.length,
      flushedDocIds: flushed,
      docIds: flushed,
      skippedDocIds: [],
      errors: [],
      durationMs: Date.now() - startedAt,
      timestamp: Date.now(),
    };
  }
}
