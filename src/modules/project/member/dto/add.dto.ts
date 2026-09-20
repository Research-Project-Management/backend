import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Role } from '@prisma/client';

export class AddProjectMemberDto {
  @ApiProperty({
    description: 'User ID of the researcher to add to the project',
    example: 'd3b07384-d113-4678-831e-4eeea6608930',
  })
  @IsString()
  @IsNotEmpty({ message: 'User ID is required' })
  userId!: string;

  @ApiPropertyOptional({
    description:
      'Role to assign in the project. Defaults to contributor (assignable: coordinator, contributor, reviewer).',
    enum: Role,
    default: Role.contributor,
    example: Role.contributor,
  })
  @IsEnum(Role, { message: 'Invalid project member role' })
  @IsOptional()
  role?: Role;
}

export class BulkAddProjectMembersDto {
  @ApiProperty({
    description: 'Array of user IDs to add to the project',
    example: ['d3b07384-d113-4678-831e-4eeea6608930'],
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1, { message: 'At least one user ID must be provided' })
  @ArrayMaxSize(50, {
    message: 'Cannot add more than 50 members in a single bulk operation',
  })
  userIds!: string[];

  @ApiPropertyOptional({
    description:
      'Common role to grant to all added users (defaults to contributor)',
    enum: Role,
    default: Role.contributor,
    example: Role.contributor,
  })
  @IsEnum(Role, { message: 'Invalid project member role' })
  @IsOptional()
  role?: Role;
}
