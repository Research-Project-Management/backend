import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { ViewService } from './view.service';
import { CreateViewDto, UpdateViewDto, QueryViewDto } from './dto/view.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';
import { QueryWorkItemDto } from '../core/dto/query.dto';

@ApiTags('Work Item Saved Views')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1', 'api'])
@UseGuards(JwtAuthGuard)
export class ViewController {
  constructor(private readonly viewService: ViewService) {}

  @Get('projects/:projectId/views')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary:
      'List all saved views in a project (public views and caller private views)',
  })
  @ApiResponse({
    status: 200,
    description: 'List of saved views with favorite indicator',
  })
  async getViews(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Query() queryViewDto: QueryViewDto,
  ) {
    return this.viewService.getViews(projectId, userId, queryViewDto);
  }

  @Post('projects/:projectId/views')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Create a new saved view in a project' })
  @ApiResponse({ status: 201, description: 'Created saved view object' })
  async createView(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() createViewDto: CreateViewDto,
  ) {
    return this.viewService.createView(projectId, userId, createViewDto);
  }

  @Get('projects/:projectId/views/:viewId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get details of a specific saved view' })
  @ApiResponse({ status: 200, description: 'Saved view detail' })
  async getView(
    @Param('projectId') projectId: string,
    @Param('viewId') viewId: string,
    @CurrentUser('id') userId: string,
    @Req() request: any,
  ) {
    const userRole = request.projectMember?.role;
    return this.viewService.getView(projectId, viewId, userId, userRole);
  }

  @Patch('projects/:projectId/views/:viewId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Update a saved view (PATCH)' })
  @ApiResponse({ status: 200, description: 'Updated saved view object' })
  async patchView(
    @Param('projectId') projectId: string,
    @Param('viewId') viewId: string,
    @CurrentUser('id') userId: string,
    @Body() updateViewDto: UpdateViewDto,
    @Req() request: any,
  ) {
    const userRole = request.projectMember?.role;
    return this.viewService.updateView(
      projectId,
      viewId,
      userId,
      updateViewDto,
      userRole,
    );
  }

  @Put('projects/:projectId/views/:viewId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Update a saved view (PUT alias)' })
  @ApiResponse({ status: 200, description: 'Updated saved view object' })
  async updateView(
    @Param('projectId') projectId: string,
    @Param('viewId') viewId: string,
    @CurrentUser('id') userId: string,
    @Body() updateViewDto: UpdateViewDto,
    @Req() request: any,
  ) {
    const userRole = request.projectMember?.role;
    return this.viewService.updateView(
      projectId,
      viewId,
      userId,
      updateViewDto,
      userRole,
    );
  }

  @Delete('projects/:projectId/views/:viewId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Delete a saved view' })
  @ApiResponse({ status: 200, description: 'Saved view deleted confirmation' })
  async deleteView(
    @Param('projectId') projectId: string,
    @Param('viewId') viewId: string,
    @CurrentUser('id') userId: string,
    @Req() request: any,
  ) {
    const userRole = request.projectMember?.role;
    return this.viewService.deleteView(projectId, viewId, userId, userRole);
  }

  @Post('projects/:projectId/views/:viewId/favorite')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Add a saved view to personal favorites' })
  @ApiResponse({
    status: 200,
    description: 'Saved view added to favorites confirmation',
  })
  async favorite(
    @Param('projectId') projectId: string,
    @Param('viewId') viewId: string,
    @CurrentUser('id') userId: string,
    @Req() request: any,
  ) {
    const userRole = request.projectMember?.role;
    return this.viewService.toggleFavorite(projectId, viewId, userId, userRole);
  }

  @Get('projects/:projectId/user-favorite-views')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get list of favorite view IDs for the user' })
  @ApiResponse({
    status: 200,
    description: 'Array of favorite view IDs',
  })
  async getFavoriteViews(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.viewService.getFavoriteViews(projectId, userId);
  }

  @Post('projects/:projectId/user-favorite-views')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'Add a view to favorites via user-favorite-views collection',
  })
  @ApiResponse({ status: 200, description: 'View added to favorites' })
  async addFavoriteView(
    @Param('projectId') projectId: string,
    @Body('viewId') viewId: string,
    @CurrentUser('id') userId: string,
    @Req() request: any,
  ) {
    const userRole = request.projectMember?.role;
    return this.viewService.favorite(projectId, viewId, userId, userRole);
  }

  @Delete([
    'projects/:projectId/views/:viewId/favorite',
    'projects/:projectId/user-favorite-views/:viewId',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Remove a saved view from personal favorites' })
  @ApiResponse({
    status: 200,
    description: 'Saved view removed from favorites confirmation',
  })
  async unfavorite(
    @Param('projectId') projectId: string,
    @Param('viewId') viewId: string,
    @CurrentUser('id') userId: string,
    @Req() request: any,
  ) {
    const userRole = request.projectMember?.role;
    return this.viewService.unfavorite(projectId, viewId, userId, userRole);
  }

  @Get('projects/:projectId/views/:viewId/work-items')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary:
      'Execute saved view query directly to retrieve matching work items',
  })
  @ApiResponse({
    status: 200,
    description: 'List of work items matching the view criteria',
  })
  async getViewWorkItems(
    @Param('projectId') projectId: string,
    @Param('viewId') viewId: string,
    @CurrentUser('id') userId: string,
    @Query() queryWorkItemDto: QueryWorkItemDto,
    @Req() request: any,
  ) {
    const userRole = request.projectMember?.role;
    return this.viewService.getViewWorkItems(
      projectId,
      viewId,
      userId,
      userRole,
      queryWorkItemDto,
    );
  }
}
