/**
 * modules/pages/docstore/controllers/doc.controller.ts
 * Thin Domain Controller handling PageDoc CRUD and OCC writes.
 * Delegates aggregate lifecycle and business logic to PageService and DocstoreService.
 */

import {
  Controller,
  Get,
  Put,
  Post,
  Patch,
  Param,
  Body,
  HttpStatus,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  ResolvedSpace,
} from '@/modules/project/access';
import { DocstoreService } from '../docstore.service';
import {
  PageService,
  UpdatePageContentParams,
  PageDocRanges,
} from '@/modules/pages/core/services/page.service';

export type { PageDocRanges };

@ApiTags('Manuscripts - Pages Compatibility Bridge')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class DocController {
  constructor(
    private readonly pageService: PageService,
    private readonly docstoreService: DocstoreService,
  ) {}

  // ─── 1. CORE DOCUMENT CONTENT & METADATA ──────────────────────────────────────

  /**
   * GET /api/v1/manuscripts/pages/:pageId
   * GET /api/v1/manuscripts/docs/:pageId
   */
  @Get(['pages/:pageId', 'docs/:pageId'])
  @ApiOperation({ summary: 'Get document by pageId from database' })
  async getPageById(
    @Param('pageId') pageId: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.getPageById(pageId, authorizedProjectId);
  }

  /**
   * PUT /api/v1/manuscripts/pages/:pageId
   * PUT /api/v1/manuscripts/docs/:pageId
   * PUT /api/v1/manuscripts/projects/:projectId/docs/:pageId
   * PUT /api/v1/manuscripts/projects/:projectId/docs/doc/:pageId
   */
  @Put([
    'pages/:pageId',
    'docs/:pageId',
    'spaces/:spaceId/docs/:pageId',
    'spaces/:spaceId/docs/doc/:pageId',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({ summary: 'Update document content by pageId' })
  async updatePageContent(
    @Param('pageId') pageId: string,
    @Body() body: UpdatePageContentParams,
    @Param('spaceId') routeSpaceId?: string,
    @ResolvedSpace() authorizedSpaceId?: string | { id: string } | null,
  ) {
    return this.pageService.updatePageContent(
      pageId,
      body,
      authorizedSpaceId || routeSpaceId,
    );
  }

  /**
   * POST /api/v1/pages/spaces/:spaceId/docs/:pageId
   * POST /api/v1/pages/spaces/:spaceId/docs/doc/:pageId
   * POST /api/v1/pages/spaces/:spaceId/updater/doc/:pageId/update
   */
  @Post([
    'spaces/:spaceId/docs/:pageId',
    'spaces/:spaceId/docs/doc/:pageId',
    'spaces/:spaceId/updater/doc/:pageId/update',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update or queue document lines with OCC enforcement',
  })
  async updateOrQueueDocLines(
    @Param('spaceId') spaceId: string,
    @Param('pageId') pageId: string,
    @Body()
    body: UpdatePageContentParams & {
      docLines?: string[];
      rev?: number;
      clientRev?: number;
    },
    @ResolvedSpace() authorizedSpaceId?: string | { id: string } | null,
  ) {
    const normalizedBody: UpdatePageContentParams = {
      ...body,
      lines: body.lines ?? body.docLines,
      expectedRev: body.expectedRev ?? body.rev ?? body.clientRev,
    };
    return this.pageService.updatePageContent(
      pageId,
      normalizedBody,
      authorizedSpaceId || spaceId,
    );
  }

  /**
   * PATCH /api/v1/pages/spaces/:spaceId/docs/:pageId
   * PATCH /api/v1/pages/spaces/:spaceId/docs/doc/:pageId
   */
  @Patch(['spaces/:spaceId/docs/:pageId', 'spaces/:spaceId/docs/doc/:pageId'])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Patch document path or soft-delete metadata' })
  async patchProjectDoc(
    @Param('spaceId') spaceId: string,
    @Param('pageId') pageId: string,
    @Body()
    body: {
      path?: string;
      name?: string;
      deleted?: boolean;
      deletedAt?: string;
    },
    @ResolvedSpace() authorizedSpaceId?: string | { id: string } | null,
  ) {
    const resolvedSpaceId =
      (typeof authorizedSpaceId === 'string'
        ? authorizedSpaceId
        : authorizedSpaceId?.id) || spaceId;
    return this.docstoreService.patchDoc(resolvedSpaceId, pageId, body);
  }
}
