import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import { SavedSearchesService } from '../application/services/saved-searches.service';
import { JwtAuthGuard } from '../../../iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '../../../iam/authz/guards/role.guard';
import { ProjectRoles } from '../../../iam/authz/decorators/role.decorator';
import {
  CreateSavedSearchDto,
  UpdateSavedSearchDto,
  PreviewSavedSearchDto,
  ExecuteSavedSearchQueryDto,
} from '../application/dtos/saved-search.dto';

const toValidProjectId = (val?: string): string | undefined =>
  val && val !== 'me' && val !== 'user' && val !== 'personal' && isUUID(val)
    ? val
    : undefined;

@ApiTags('Library Saved Searches')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/saved-searches',
  'api/v1/projects/:projectId/library/saved-searches',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class SavedSearchesController {
  constructor(private readonly service: SavedSearchesService) {}

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List saved searches (smart collections)' })
  async findAll(
    @CurrentUser('id') userId: string,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );
    return this.service.findAll(userId, effectiveProjectId);
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Create a saved search (smart collection)' })
  async create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateSavedSearchDto,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId || dto.projectId,
    );
    return this.service.create(userId, dto, effectiveProjectId);
  }

  @Post('preview')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Preview saved search results count and sample' })
  async preview(
    @CurrentUser('id') userId: string,
    @Body() dto: PreviewSavedSearchDto,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId || dto.projectId,
    );
    return this.service.preview(userId, dto, effectiveProjectId);
  }

  @Get(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get a saved search by ID' })
  async findById(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );
    return this.service.findById(userId, id, effectiveProjectId);
  }

  @Patch(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update a saved search' })
  async update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateSavedSearchDto,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );
    return this.service.update(userId, id, dto, effectiveProjectId);
  }

  @Delete(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete a saved search' })
  async delete(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );
    return this.service.delete(userId, id, effectiveProjectId);
  }

  @Get(':id/results')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Execute a saved search and get matching items' })
  async execute(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query() query: ExecuteSavedSearchQueryDto,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || query.projectId,
    );
    return this.service.execute(userId, id, query, effectiveProjectId);
  }
}
