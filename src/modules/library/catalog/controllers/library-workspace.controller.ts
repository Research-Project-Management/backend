import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';
import { normalizeProjectScopeId } from '@/modules/library/core';
import { CursorPaginationQueryDto } from '@/modules/library/catalog/dto/items.dto';
import { ItemQueryService } from '@/modules/library/catalog/services/item-query.service';
import { LibraryBootstrapService } from '@/modules/library/catalog/services/library-bootstrap.service';

export interface RequestWithAccessHint {
  role?: string;
  projectMember?: {
    role?: string;
    permissionOverrides?: Record<string, boolean> | null;
    effectivePermissions?: readonly string[];
  };
  accessContext?: {
    role?: string;
    permissionOverrides?: Record<string, boolean> | null;
    effectivePermissions?: readonly string[];
  };
  permissions?: readonly string[];
}

export type ItemsListQuery = CursorPaginationQueryDto & {
  view?:
    | 'all'
    | 'recent'
    | 'unfiled'
    | 'trash'
    | 'my-publications'
    | 'publications'
    | 'starred'
    | 'retracted';
  collectionId?: string;
  tagId?: string;
  search?: string;
  fields?: string;
  projectId?: string;
};

export function extractRequestAccessHint(req?: RequestWithAccessHint) {
  if (!req) return undefined;
  const ctx = req.accessContext || req.projectMember;
  return {
    role: ctx?.role || req.role,
    permissionOverrides: ctx?.permissionOverrides,
    effectivePermissions: ctx?.effectivePermissions || req.permissions,
  };
}

export function buildGetItemsOptions(
  query?: ItemsListQuery,
  projectId?: string | null,
) {
  const effectiveProjectId = normalizeProjectScopeId(
    projectId ?? query?.projectId,
  );
  const effectiveOrderBy = query?.orderBy ?? query?.sortBy;
  const effectiveOrderDirection = query?.orderDirection ?? query?.sortOrder;
  const effectiveFromYear = query?.fromYear ?? query?.year;
  const effectiveToYear = query?.toYear ?? query?.year;
  const effectiveTag =
    query?.tag ??
    (Array.isArray(query?.tags) && query.tags.length > 0
      ? query.tags.join(',')
      : undefined);
  const effectiveHasFile = query?.hasFile ?? query?.hasPdf;
  const effectiveOnlyFlagged = query?.onlyFlagged ?? query?.isStarred;
  const effectiveView = query?.view ?? (query?.unfiled ? 'unfiled' : undefined);
  const effectiveReadStatus =
    query?.readStatus ??
    (query?.isRead === true
      ? 'completed'
      : query?.isRead === false
        ? 'unread'
        : undefined);

  return {
    view: effectiveView,
    collectionId: query?.collectionId,
    tagId: query?.tagId,
    search: query?.search,
    ...(query?.searchMode !== undefined
      ? { searchMode: query.searchMode }
      : {}),
    cursor: query?.cursor,
    limit: query?.limit,
    projectId: effectiveProjectId,
    ...(query?.page !== undefined ? { page: query.page } : {}),
    ...(effectiveOrderBy !== undefined ? { orderBy: effectiveOrderBy } : {}),
    ...(effectiveOrderDirection !== undefined
      ? { orderDirection: effectiveOrderDirection }
      : {}),
    ...(query?.itemType !== undefined ? { itemType: query.itemType } : {}),
    ...(query?.type !== undefined ? { type: query.type } : {}),
    ...(effectiveFromYear !== undefined ? { fromYear: effectiveFromYear } : {}),
    ...(effectiveToYear !== undefined ? { toYear: effectiveToYear } : {}),
    ...(effectiveReadStatus !== undefined
      ? { readStatus: effectiveReadStatus }
      : {}),
    ...(effectiveHasFile !== undefined ? { hasFile: effectiveHasFile } : {}),
    ...(query?.hasNotes !== undefined ? { hasNotes: query.hasNotes } : {}),
    ...(effectiveOnlyFlagged !== undefined
      ? { onlyFlagged: effectiveOnlyFlagged }
      : {}),
    ...(query?.isRetracted !== undefined
      ? { isRetracted: query.isRetracted }
      : {}),
    ...(effectiveTag !== undefined ? { tag: effectiveTag } : {}),
    ...(query?.collectionIds !== undefined
      ? { collectionIds: query.collectionIds }
      : {}),
    ...(query?.includeSubcollections !== undefined
      ? { includeSubcollections: query.includeSubcollections }
      : {}),
    ...(query?.recursive !== undefined ? { recursive: query.recursive } : {}),
    ...(query?.fields !== undefined ? { fields: query.fields } : {}),
  };
}

@ApiTags('Library Permissions')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/library', 'api/v1/projects/:projectId/library'])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class LibraryPermissionsController {
  constructor(
    private readonly queryService: ItemQueryService,
    private readonly bootstrapService?: LibraryBootstrapService,
  ) {}

  private extractAccessHint(req?: RequestWithAccessHint) {
    return extractRequestAccessHint(req);
  }

  @Get('bootstrap')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary:
      'Consolidated single-request workspace bootstrap for personal or project library',
  })
  async getLibraryBootstrap(
    @CurrentUser('id') userId: string,
    @Query() query?: ItemsListQuery & { includeItems?: string | boolean },
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
    @Req() req?: RequestWithAccessHint,
  ) {
    const projectId = normalizeProjectScopeId(
      paramProjectId || queryProjectId || query?.projectId,
    );
    const includeItems =
      query?.includeItems !== 'false' && query?.includeItems !== false;
    const baseOptions = buildGetItemsOptions(query, projectId);

    return this.bootstrapService?.getBootstrap(
      userId,
      {
        ...baseOptions,
        includeItems,
      },
      this.extractAccessHint(req),
    );
  }

  @Get('permissions')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary:
      'Get authoritative library permissions for personal or project scope',
  })
  async getLibraryPermissions(
    @CurrentUser('id') userId: string,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
    @Req() req?: RequestWithAccessHint,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.queryService.getPermissions(
      userId,
      projectId,
      this.extractAccessHint(req),
    );
  }
}
