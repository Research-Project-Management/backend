import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { SearchService } from './search.service';
import { SemanticSearchService } from './services/semantic-search.service';
import { SearchItemsQueryDto } from './dto/search.dto';
import { SemanticSearchDto } from './dto/semantic-search.dto';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '../../../modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '../../../modules/iam/authz/decorators/role.decorator';

@Controller([
  'api/v1/library/search',
  'api/v1/projects/:projectId/library/search',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class SearchController {
  constructor(
    private readonly searchService: SearchService,
    private readonly semanticSearch: SemanticSearchService,
  ) {}

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async searchItems(
    @CurrentUser('id') userId: string,
    @Query() dto: SearchItemsQueryDto,
    @Param('projectId') routeProjectId?: string,
  ) {
    if (routeProjectId && !dto.projectId) {
      dto.projectId = routeProjectId;
    }
    return this.searchService.search(userId, dto);
  }

  @Post('semantic')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async searchSemantic(
    @CurrentUser('id') userId: string,
    @Body() dto: SemanticSearchDto,
    @Param('projectId') routeProjectId?: string,
  ) {
    if (routeProjectId && !dto.projectId) {
      dto.projectId = routeProjectId;
    }
    return this.semanticSearch.searchSemantic(userId, dto);
  }

  @Get('items/:id/related')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getRelatedItems(
    @CurrentUser('id') userId: string,
    @Param('id') itemId: string,
    @Query('limit') limit?: string,
    @Query('projectId') projectId?: string,
    @Param('projectId') routeProjectId?: string,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : 5;
    const effectiveProjectId = routeProjectId || projectId;
    return this.semanticSearch.findRelatedItems(
      userId,
      itemId,
      parsedLimit,
      effectiveProjectId,
    );
  }

  @Post('index-all')
  async indexAll(
    @CurrentUser('id') userId: string,
    @CurrentUser() user: any,
    @Query('projectId') projectId?: string,
  ) {
    if (!user?.isAdmin && !user?.role?.includes('admin')) {
      throw new ForbiddenException('Admin access required');
    }
    return this.semanticSearch.indexLibrary(userId, projectId);
  }

  @Get('attachments/:attachmentId/anchors')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async searchAnchors(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Query('term') term: string,
    @Query('pageIndex') pageIndex?: string,
  ) {
    const parsedPage =
      pageIndex !== undefined ? parseInt(pageIndex, 10) : undefined;
    return this.searchService.searchPageAnchors(
      userId,
      attachmentId,
      term,
      parsedPage,
    );
  }
}
