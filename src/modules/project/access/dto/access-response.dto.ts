import { ApiProperty } from '@nestjs/swagger';
import { Role } from '../enums/role.enum';
import { Permission } from '../enums/permission.enum';
import { PermissionOverrideMap } from '../types/access.type';

/**
 * Project Member Access & Permissions Response payload.
 */
export class MemberAccessResponseDto {
  @ApiProperty({ enum: Role, description: 'User role in project' })
  role!: Role;

  @ApiProperty({ description: 'Hierarchy level number', example: 40 })
  level!: number;

  @ApiProperty({ description: 'Human-readable role label' })
  label!: string;

  @ApiProperty({ description: 'Role responsibility description' })
  description!: string;

  @ApiProperty({
    description: 'Configured granular permission overrides for this member',
    example: { 'document:delete': false, 'library:export': true },
  })
  overrides!: PermissionOverrideMap;

  @ApiProperty({
    type: [String],
    description:
      'Array of effective permissions (Role Baseline + Overrides combined)',
  })
  effectivePermissions!: readonly Permission[];

  @ApiProperty({
    type: [String],
    description: 'Backward compatibility alias for effectivePermissions',
  })
  permissions!: readonly Permission[];
}

export const ProjectRoleResponseDto = MemberAccessResponseDto;
export type ProjectRoleResponseDto = MemberAccessResponseDto;
