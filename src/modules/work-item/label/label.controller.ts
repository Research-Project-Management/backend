import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { LabelService } from './label.service';
import { CreateLabelDto, UpdateLabelDto, QueryLabelDto } from './dto/label.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { LabelType } from '@prisma/client';

import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';

@ApiTags('Organization')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class LabelController {
  constructor(private readonly labelService: LabelService) {}

  @Get([
    'workspaces/:workspaceId/labels',
    'workspace/:workspaceId/labels',
    'labels/:workspaceId',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary: 'List labels in a workspace (optionally filter by type)',
  })
  async getLabels(
    @Param('workspaceId') workspaceId: string,
    @Query() query?: QueryLabelDto,
  ) {
    return this.labelService.getLabels(workspaceId, query?.type);
  }

  @Post([
    'workspaces/:workspaceId/labels',
    'workspace/:workspaceId/labels',
    'labels/:workspaceId',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Create a new label in a workspace' })
  async createLabel(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateLabelDto,
  ) {
    return this.labelService.createLabel(workspaceId, userId, dto);
  }

  @Put('labels/:labelId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Update a label name or color' })
  async updateLabel(
    @Param('labelId') labelId: string,
    @Body() dto: UpdateLabelDto,
  ) {
    return this.labelService.updateLabel(labelId, dto);
  }

  @Delete('labels/:labelId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin')
  @ApiOperation({ summary: 'Delete a label' })
  async deleteLabel(@Param('labelId') labelId: string) {
    return this.labelService.deleteLabel(labelId);
  }
}
