import { Controller, Get, Param, Query, Req, UseGuards, Post, Body, NotFoundException, Header, Put, Patch, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser, Public } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles, ProjectAccessGuard } from '@/modules/project/access';
import { normalizeProjectScopeId } from '@/modules/library/core';
import { CursorPaginationQueryDto } from '@/modules/library/catalog/dto/items.dto';
import { ItemQueryService } from '@/modules/library/catalog/services/item-query.service';
import { LibraryBootstrapService } from '@/modules/library/catalog/services/library-bootstrap.service';
import { IsString, IsObject, MaxLength } from 'class-validator';
import { TypesService } from '@/modules/library/catalog/services/zotero-schema-validator.service';
import { ZoteroSchemaValidatorService } from '@/modules/library/catalog/services/zotero-schema-validator.service';
import { StateService } from '@/modules/library/catalog/services/state.service';
import { UpdateStateDto, GetBatchStatesDto } from '@/modules/library/catalog/dto/collections.dto';

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

export class ItemsListQuery extends CursorPaginationQueryDto {}

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
    ...(query?.ids !== undefined ? { ids: query.ids } : {}),
    ...(effectiveTag !== undefined ? { tag: effectiveTag } : {}),
    ...(query?.collectionIds !== undefined
      ? { collectionIds: query.collectionIds }
      : {}),
    ...(query?.includeSubcollections !== undefined
      ? { includeSubcollections: query.includeSubcollections }
      : {}),
    ...(query?.recursive !== undefined ? { recursive: query.recursive } : {}),
    ...(query?.fields !== undefined ? { fields: query.fields } : {}),
    ...(query?.checkInProjectId
      ? { checkInProjectId: normalizeProjectScopeId(query.checkInProjectId) }
      : {}),
  };
}

@ApiTags('Library Workspace')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/library', 'api/v1/projects/:projectId/library'])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class LibraryWorkspaceController {
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

export { LibraryWorkspaceController as LibraryPermissionsController };

export class ValidateItemPayloadDto {
  @IsString()
  @MaxLength(100)
  itemType!: string;

  @IsObject()
  data!: Record<string, unknown>;
}

@ApiTags('Library Item Types & Academic Schema')
@ApiBearerAuth()
@Controller(['api/v1/library/types', 'api/v1/library/item-types'])
@UseGuards(JwtAuthGuard)
export class TypeController {
  constructor(
    private readonly typesService: TypesService,
    private readonly schemaValidator: ZoteroSchemaValidatorService,
  ) {}

  @Public()
  @Get()
  @Header(
    'Cache-Control',
    'public, max-age=86400, stale-while-revalidate=604800',
  )
  listAllItemTypes() {
    const snapshot = this.typesService.getSnapshot();
    const itemTypes = this.typesService.getAllItemTypes();
    return {
      success: true,
      schemaVersion: snapshot.version,
      count: itemTypes.length,
      itemTypes,
      baseFieldMappings: snapshot.baseFieldMappings,
      creatorRoles: snapshot.creatorRoles,
      cslTypeMap: snapshot.cslTypeMap,
      cslFieldMap: snapshot.cslFieldMap,
    };
  }

  @Public()
  @Get('schema')
  @Header(
    'Cache-Control',
    'public, max-age=86400, stale-while-revalidate=604800',
  )
  getSchemaSnapshot() {
    const snapshot = this.typesService.getSnapshot();
    return {
      success: true,
      data: snapshot,
    };
  }

  @Public()
  @Get(':itemType')
  @Header(
    'Cache-Control',
    'public, max-age=86400, stale-while-revalidate=604800',
  )
  getItemTypeDefinition(@Param('itemType') itemType: string) {
    const def = this.typesService.getItemType(itemType);
    if (!def) {
      throw new NotFoundException(
        `Item type '${itemType}' is not a valid academic bibliographic type`,
      );
    }
    return {
      success: true,
      itemType: def,
    };
  }

  @Public()
  @Post('validate')
  validateItemPayload(@Body() body: ValidateItemPayloadDto) {
    const type = body?.itemType || 'journalArticle';
    const data = body?.data || {};
    const validation = this.schemaValidator.validateAndSanitizeItem(type, data);
    return {
      success: validation.valid,
      ...validation,
    };
  }
}

@ApiTags('Library Reading State')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/items/:itemId/state',
  'api/v1/projects/:projectId/library/items/:itemId/state',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class StateController {
  constructor(protected readonly stateService: StateService) {}

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get user reading state for an item' })
  async getState(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.stateService.getState(userId, itemId, projectId);
  }

  @Put()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Update user reading state for an item' })
  async updateState(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateStateDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.stateService.updateState(userId, itemId, dto, projectId);
  }

  @Patch()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Patch user reading state for an item' })
  async patchState(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateStateDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    return this.updateState(
      userId,
      itemId,
      dto,
      queryProjectId,
      paramProjectId,
    );
  }

  @Post(['mark-read', 'read'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark item as read' })
  async markAsRead(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.stateService.markAsRead(userId, itemId, projectId);
  }
}

@ApiTags('Library Reading State')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/state',
  'api/v1/projects/:projectId/library/state',
  'api/v1/library/items/state',
  'api/v1/projects/:projectId/library/items/state',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class StateBatchController {
  constructor(protected readonly stateService: StateService) {}

  @Post('batch')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get batch reading states for items' })
  async getBatchStates(
    @CurrentUser('id') userId: string,
    @Body() dto?: GetBatchStatesDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.stateService.getBatchStates(
      userId,
      dto?.itemIds || [],
      projectId,
    );
  }
}
