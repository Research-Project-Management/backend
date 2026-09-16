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
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { MemberService } from './member.service';
import { AddProjectMemberDto, BulkAddProjectMembersDto } from './dto/add.dto';
import { UpdateProjectMemberDto } from './dto/update.dto';
import { QueryProjectMembersDto } from './dto/query.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

@ApiTags('Project Members')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/projects',
  'api/v1/project',
  'api/projects',
  'api/project',
])
@UseGuards(JwtAuthGuard)
export class MemberController {
  constructor(private readonly memberService: MemberService) {}

  @Get(':projectId/members')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'List project members with filtering and pagination',
  })
  @ApiResponse({ status: 200, description: 'List of members in project' })
  async getMembers(
    @Param('projectId') projectId: string,
    @Query() query: QueryProjectMembersDto,
  ) {
    return this.memberService.getMembers(projectId, query);
  }

  @Get(':projectId/members/:userId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get details of a specific project member' })
  @ApiResponse({ status: 200, description: 'Member details' })
  async getMember(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
  ) {
    return this.memberService.getMember(projectId, userId);
  }

  @Post(':projectId/members')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'Add a member to the project' })
  @ApiResponse({
    status: 201,
    description: 'Project member added successfully',
  })
  async addMember(
    @Param('projectId') projectId: string,
    @CurrentUser('id') actorId: string,
    @Body() dto: AddProjectMemberDto,
  ) {
    return this.memberService.addMember(projectId, dto, actorId);
  }

  @Post(':projectId/members/bulk')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({
    summary: 'Bulk-add members to the project with designated roles',
  })
  @ApiResponse({ status: 201, description: 'Added members count and list' })
  async bulkAddMembers(
    @Param('projectId') projectId: string,
    @CurrentUser('id') actorId: string,
    @Body() dto: BulkAddProjectMembersDto,
  ) {
    return this.memberService.bulkAddMembers(projectId, dto, actorId);
  }

  @Put(':projectId/members/:userId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({
    summary: 'Update project member role (Single-Owner protected)',
  })
  @ApiResponse({
    status: 200,
    description: 'Project member role updated successfully',
  })
  async updateMemberRole(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @CurrentUser('id') actorId: string,
    @Body() dto: UpdateProjectMemberDto,
  ) {
    return this.memberService.updateMemberRole(projectId, userId, dto, actorId);
  }

  @Delete(':projectId/members/:userId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({
    summary: 'Remove a member from the project (Single-Owner protected)',
  })
  @ApiResponse({
    status: 200,
    description: 'Project member removed successfully',
  })
  async removeMember(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.memberService.removeMember(projectId, userId, actorId);
  }

  @Post(':projectId/leave')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Leave project (Single-Owner protected)' })
  @ApiResponse({ status: 200, description: 'Left project successfully' })
  async leaveProject(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.memberService.leaveProject(projectId, userId);
  }
}
