import { IsEnum, IsNotEmpty, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Permission } from '../enums/permission.enum';
import { Role } from '../enums/role.enum';

/**
 * Request payload to verify user permissions or roles in a project.
 */
export class CheckAccessDto {
  @ApiProperty({
    description: 'Target Project UUID',
    example: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  })
  @IsUUID()
  @IsNotEmpty()
  projectId!: string;

  @ApiPropertyOptional({
    enum: Permission,
    description: 'Specific domain permission to verify',
    example: Permission.DOCUMENT_EDIT,
  })
  @IsEnum(Permission)
  @IsOptional()
  permission?: Permission;

  @ApiPropertyOptional({
    enum: Role,
    description: 'Minimum role hierarchy requirement',
    example: Role.CONTRIBUTOR,
  })
  @IsEnum(Role)
  @IsOptional()
  minRole?: Role;
}

export const CheckAuthzDto = CheckAccessDto;
export type CheckAuthzDto = CheckAccessDto;
