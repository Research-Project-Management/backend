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
import { AccessService } from './access.service';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';
import { Role, RoleHierarchy, ROLE_DESCRIPTIONS } from './enums/role.enum';
import { ROLE_PERMISSIONS } from './constants/permission.constant';
import { CheckAccessDto } from './dto/check-access.dto';
import { MemberAccessResponseDto } from './dto/access-response.dto';

@ApiTags('Project Access Control')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/projects', 'api/projects', 'api/v1/authz', 'api/authz'])
@UseGuards(JwtAuthGuard)
export class AccessController {
  constructor(private readonly accessService: AccessService) {}

  @Get(':projectId/access/my-permissions')
  @ApiOperation({
    summary:
      'Get current user access context, role, overrides, and effective permissions in a project',
  })
  @ApiResponse({
    status: 200,
    description: 'Active project role, overrides, and effective permissions',
    type: MemberAccessResponseDto,
  })
  async getMyAccess(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ): Promise<MemberAccessResponseDto> {
    return this.buildAccessResponse(projectId, userId);
  }

  // Legacy route compatibility for frontend
  @Get('projects/:projectId/permissions')
  @ApiOperation({
    summary: 'Legacy endpoint: Get user role and permissions in a project',
  })
  @ApiResponse({
    status: 200,
    type: MemberAccessResponseDto,
  })
  async getProjectPermissions(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ): Promise<MemberAccessResponseDto> {
    return this.buildAccessResponse(projectId, userId);
  }

  @Post('access/check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify if current user possesses permission or role in a project',
  })
  @ApiResponse({ status: 200, description: 'Evaluation result' })
  async checkAccess(
    @CurrentUser('id') userId: string,
    @Body() dto: CheckAccessDto,
  ) {
    const context = await this.accessService.getMemberAccessContext(
      dto.projectId,
      userId,
    );

    if (!context) {
      return {
        allowed: false,
        role: null,
        reason: 'User is not a member of this project',
      };
    }

    if (dto.minRole && !this.accessService.hasRole(context.role, dto.minRole)) {
      return {
        allowed: false,
        role: context.role,
        reason: `Current role '${context.role}' does not meet required level '${dto.minRole}'`,
      };
    }

    if (
      dto.permission &&
      !this.accessService.hasPermission(
        context.role,
        dto.permission,
        context.permissionOverrides,
      )
    ) {
      return {
        allowed: false,
        role: context.role,
        missingPermission: dto.permission,
        reason: `Member lacks permission '${dto.permission}' (Role: '${context.role}', Overrides: ${JSON.stringify(context.permissionOverrides)})`,
      };
    }

    return {
      allowed: true,
      role: context.role,
      overrides: context.permissionOverrides,
      effectivePermissions: context.effectivePermissions,
    };
  }

  // Legacy route compatibility
  @Post('check')
  @HttpCode(HttpStatus.OK)
  async checkLegacy(
    @CurrentUser('id') userId: string,
    @Body() dto: CheckAccessDto,
  ) {
    return this.checkAccess(userId, dto);
  }

  @Get('access/matrix')
  @ApiOperation({
    summary: 'Get the 4-role baseline permission definitions and matrix',
  })
  @ApiResponse({ status: 200, description: 'Full role permission matrix' })
  getPermissionMatrix() {
    return {
      roles: ROLE_DESCRIPTIONS,
      hierarchy: RoleHierarchy,
      permissions: ROLE_PERMISSIONS,
    };
  }

  // Legacy route compatibility
  @Get('matrix')
  getMatrixLegacy() {
    return this.getPermissionMatrix();
  }

  private async buildAccessResponse(
    projectId: string,
    userId: string,
  ): Promise<MemberAccessResponseDto> {
    const context = await this.accessService.getMemberAccessContext(
      projectId,
      userId,
    );

    if (!context) {
      throw new ForbiddenException(
        'Access denied: You are not a member of this project',
      );
    }

    const meta = ROLE_DESCRIPTIONS[context.role];

    return {
      role: context.role,
      level: RoleHierarchy[context.role] || 0,
      label: meta.label,
      description: meta.description,
      overrides: context.permissionOverrides,
      effectivePermissions: context.effectivePermissions,
      permissions: context.effectivePermissions,
    };
  }
}
