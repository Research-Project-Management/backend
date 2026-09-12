import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { AuthzService } from './authz.service';
import { JwtAuthGuard } from '../authn/guards/auth.guard';
import { CurrentUser } from '../authn/decorators/user.decorator';
import { Role, RoleHierarchy, ROLE_DESCRIPTIONS } from './enums/role.enum';
import { ROLE_PERMISSIONS } from './constants/permission.constant';
import { CheckAuthzDto } from './dto/check.dto';
import { ProjectRoleResponseDto } from './dto/role.dto';

@ApiTags('IAM - Authorization')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/authz', 'api/authz'])
@UseGuards(JwtAuthGuard)
export class AuthzController {
  constructor(private readonly authzService: AuthzService) {}

  @Get('projects/:projectId/permissions')
  @ApiOperation({
    summary: 'Get current user role and permissions in a project',
  })
  @ApiResponse({
    status: 200,
    description: 'Active project role and permissions',
    type: ProjectRoleResponseDto,
  })
  async getProjectPermissions(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ): Promise<ProjectRoleResponseDto> {
    const role = await this.authzService.getRole(projectId, userId);
    if (!role) {
      throw new ForbiddenException(
        'Access denied: You are not a member of this project',
      );
    }

    const permissions = this.authzService.getRolePermissions(role);
    const meta = ROLE_DESCRIPTIONS[role];

    return {
      role,
      level: RoleHierarchy[role] || 0,
      label: meta.label,
      description: meta.description,
      permissions,
    };
  }

  @Post('check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify if current user possesses permission or role',
  })
  @ApiResponse({ status: 200, description: 'Evaluation result' })
  async checkPermission(
    @CurrentUser('id') userId: string,
    @Body() dto: CheckAuthzDto,
  ) {
    const role = await this.authzService.getRole(dto.projectId, userId);
    if (!role) {
      return {
        allowed: false,
        role: null,
        reason: 'User is not a member of this project',
      };
    }

    if (dto.minRole && !this.authzService.hasRole(role, dto.minRole)) {
      return {
        allowed: false,
        role,
        reason: `Current role '${role}' does not meet required level '${dto.minRole}'`,
      };
    }

    if (
      dto.permission &&
      !this.authzService.hasPermission(role, dto.permission)
    ) {
      return {
        allowed: false,
        role,
        missingPermission: dto.permission,
        reason: `Role '${role}' lacks permission '${dto.permission}'`,
      };
    }

    return {
      allowed: true,
      role,
    };
  }

  @Get('matrix')
  @ApiOperation({
    summary: 'Get the 4-role permission definitions and matrix',
  })
  @ApiResponse({ status: 200, description: 'Full role permission matrix' })
  getPermissionMatrix() {
    return {
      roles: ROLE_DESCRIPTIONS,
      hierarchy: RoleHierarchy,
      permissions: ROLE_PERMISSIONS,
    };
  }
}
