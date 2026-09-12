import { ApiProperty } from '@nestjs/swagger';
import { Role, RoleHierarchy, ROLE_DESCRIPTIONS } from '../enums/role.enum';
import { Permission } from '../enums/permission.enum';

/**
 * Project Member Permissions & Role Response payload.
 */
export class ProjectRoleResponseDto {
  @ApiProperty({ enum: Role, description: 'User role in project' })
  role!: Role;

  @ApiProperty({ description: 'Hierarchy level number', example: 40 })
  level!: number;

  @ApiProperty({ description: 'Human-readable role label' })
  label!: string;

  @ApiProperty({ description: 'Role responsibility description' })
  description!: string;

  @ApiProperty({
    type: [String],
    description: 'Array of granted academic domain permissions',
  })
  permissions!: readonly Permission[];
}
