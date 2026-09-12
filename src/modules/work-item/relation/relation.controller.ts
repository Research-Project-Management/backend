import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { RelationService } from './relation.service';
import { AddRelationDto, RelationResponseDto } from './dto/relation.dto';

@ApiTags('Work Item Relations')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class RelationController {
  constructor(private readonly relationService: RelationService) {}

  @Get([
    'work-items/:taskId/relations',
    'tasks/:taskId/relations',
    'projects/:projectId/work-items/:taskId/relations',
    'project/:projectId/work-items/:taskId/relations',
    'projects/:projectId/tasks/:taskId/relations',
    'project/:projectId/tasks/:taskId/relations',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get all relations and blockers for a work item' })
  @ApiResponse({ status: 200, description: 'List of enriched relations' })
  async getRelations(@Param('taskId') taskId: string) {
    return this.relationService.getTaskRelations(taskId);
  }

  @Post([
    'work-items/:taskId/relations',
    'tasks/:taskId/relations',
    'projects/:projectId/work-items/:taskId/relations',
    'project/:projectId/work-items/:taskId/relations',
    'projects/:projectId/tasks/:taskId/relations',
    'project/:projectId/tasks/:taskId/relations',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Add a bidirectional relation to a work item' })
  @ApiResponse({
    status: 201,
    description: 'Relation added',
    type: RelationResponseDto,
  })
  async addRelation(
    @Param('taskId') taskId: string,
    @Body() addRelationDto: AddRelationDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.relationService.addRelation(taskId, addRelationDto, userId);
  }

  @Delete([
    'work-items/:taskId/relations/:targetTaskId',
    'tasks/:taskId/relations/:targetTaskId',
    'projects/:projectId/work-items/:taskId/relations/:targetTaskId',
    'project/:projectId/work-items/:taskId/relations/:targetTaskId',
    'projects/:projectId/tasks/:taskId/relations/:targetTaskId',
    'project/:projectId/tasks/:taskId/relations/:targetTaskId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Remove a bidirectional relation from a work item' })
  @ApiResponse({
    status: 200,
    description: 'Relation removed',
    type: RelationResponseDto,
  })
  async removeRelation(
    @Param('taskId') taskId: string,
    @Param('targetTaskId') targetTaskId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.relationService.removeRelation(taskId, targetTaskId, userId);
  }

  @Get([
    'work-items/:taskId/relations/violations',
    'tasks/:taskId/relations/violations',
    'projects/:projectId/work-items/:taskId/relations/violations',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'Get violated timeline-dependency relations for a work item',
  })
  @ApiResponse({
    status: 200,
    description: 'List of relations with violation status and reason',
  })
  async getViolations(@Param('taskId') taskId: string) {
    return this.relationService.getViolatedRelations(taskId);
  }
}
