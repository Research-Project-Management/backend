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
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { RelationService } from './relation.service';
import { AddRelationDto, RelationResponseDto } from './dto/relation.dto';

@ApiTags('Work Item Relations')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1', 'api'])
@UseGuards(JwtAuthGuard)
export class RelationController {
  constructor(private readonly relationService: RelationService) {}

  @Get('work-items/:workItemId/relations')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get all relations and blockers for a work item' })
  @ApiResponse({ status: 200, description: 'List of enriched relations' })
  async getRelations(@Param('workItemId') workItemId: string) {
    return this.relationService.getWorkItemRelations(workItemId);
  }

  @Post('work-items/:workItemId/relations')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Add a bidirectional relation to a work item' })
  @ApiResponse({
    status: 201,
    description: 'Relation added',
    type: RelationResponseDto,
  })
  async addRelation(
    @Param('workItemId') workItemId: string,
    @Body() addRelationDto: AddRelationDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.relationService.addRelation(workItemId, addRelationDto, userId);
  }

  @Delete('work-items/:workItemId/relations/:targetWorkItemId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Remove a bidirectional relation from a work item' })
  @ApiResponse({
    status: 200,
    description: 'Relation removed',
    type: RelationResponseDto,
  })
  async removeRelation(
    @Param('workItemId') workItemId: string,
    @Param('targetWorkItemId') targetWorkItemId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.relationService.removeRelation(
      workItemId,
      targetWorkItemId,
      userId,
    );
  }

  @Get('work-items/:workItemId/relations/violations')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get violated timeline-dependency relations for a work item',
  })
  @ApiResponse({
    status: 200,
    description: 'List of relations with violation status and reason',
  })
  async getViolations(@Param('workItemId') workItemId: string) {
    return this.relationService.getViolatedRelations(workItemId);
  }
}
