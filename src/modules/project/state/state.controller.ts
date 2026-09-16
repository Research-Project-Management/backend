import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  UseGuards,
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
import { StateService } from './state.service';
import { UpdateProjectStateDto } from './dto/update-project-state.dto';
import {
  ProjectStateMetadataDto,
  ProjectCurrentStateResponseDto,
} from './dto/project-state-response.dto';

@ApiTags('Project States')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller(['api/v1/projects', 'api/projects'])
export class StateController {
  constructor(private readonly stateService: StateService) {}

  @Get('states')
  @ApiOperation({ summary: 'List all standard project lifecycle states and descriptions' })
  @ApiResponse({
    status: 200,
    description: 'List of project states',
    type: [ProjectStateMetadataDto],
  })
  getStatesCatalog() {
    return this.stateService.getProjectStatesCatalog();
  }

  @Get(':projectId/state')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get current lifecycle state of a project' })
  @ApiResponse({
    status: 200,
    description: 'Current project state and allowed transitions',
    type: ProjectCurrentStateResponseDto,
  })
  getProjectState(@Param('projectId') projectId: string) {
    return this.stateService.getProjectCurrentState(projectId);
  }

  @Patch(':projectId/state')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'Update project lifecycle state (Owner only)' })
  @ApiResponse({
    status: 200,
    description: 'Updated project state',
    type: ProjectCurrentStateResponseDto,
  })
  updateProjectState(
    @Param('projectId') projectId: string,
    @Body() dto: UpdateProjectStateDto,
  ) {
    return this.stateService.updateProjectState(projectId, dto.state);
  }
}
