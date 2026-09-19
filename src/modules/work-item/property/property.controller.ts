import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
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
import { PropertyService } from './property.service';
import { UpdatePropertyDto } from './dto/property.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

@ApiTags('Work Item User Properties (Plane.so Parity)')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1', 'api'])
@UseGuards(JwtAuthGuard)
export class PropertyController {
  constructor(private readonly propertyService: PropertyService) {}

  @Get([
    'projects/:projectId/user-properties',
    'project/:projectId/user-properties',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary:
      'Get user project view preferences and display properties (Plane.so user-properties)',
  })
  @ApiResponse({
    status: 200,
    description: 'Current user view and display properties for the project',
  })
  async getUserProperties(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.propertyService.getUserProperties(projectId, userId);
  }

  @Patch([
    'projects/:projectId/user-properties',
    'project/:projectId/user-properties',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary:
      'Update user project view preferences and display properties (Plane.so user-properties)',
  })
  @ApiResponse({
    status: 200,
    description: 'Updated user properties object',
  })
  async updateUserProperties(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() updatePropertyDto: UpdatePropertyDto,
  ) {
    return this.propertyService.updateUserProperties(
      projectId,
      userId,
      updatePropertyDto,
    );
  }
}
