import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectMemberRole } from '@prisma/client';

export class AddProjectMemberDto {
  @ApiProperty({
    description: 'User ID of the workspace member to add to the project',
    example: 'd3b07384-d113-4678-831e-4eeea6608930',
  })
  @IsString()
  @IsNotEmpty({ message: 'User ID is required' })
  userId!: string;

  @ApiPropertyOptional({
    description:
      'Role to assign in the project. Defaults to contributor. Workspace viewers cannot be admin or contributor.',
    enum: ProjectMemberRole,
    default: ProjectMemberRole.contributor,
    example: ProjectMemberRole.contributor,
  })
  @IsEnum(ProjectMemberRole, { message: 'Invalid project member role' })
  @IsOptional()
  role?: ProjectMemberRole;
}

export class BulkAddProjectMembersDto {
  @ApiProperty({
    description: 'Array of user IDs to add to the project',
    example: ['d3b07384-d113-4678-831e-4eeea6608930'],
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1, { message: 'At least one user ID must be provided' })
  userIds!: string[];

  @ApiPropertyOptional({
    description:
      'Common role to grant to all added users (defaults to contributor)',
    enum: ProjectMemberRole,
    default: ProjectMemberRole.contributor,
    example: ProjectMemberRole.contributor,
  })
  @IsEnum(ProjectMemberRole, { message: 'Invalid project member role' })
  @IsOptional()
  role?: ProjectMemberRole;
}

export class UpdateProjectMemberDto {
  @ApiProperty({
    description: 'New role for the project member',
    enum: ProjectMemberRole,
    example: ProjectMemberRole.contributor,
  })
  @IsEnum(ProjectMemberRole, { message: 'Invalid project member role' })
  @IsNotEmpty({ message: 'Role is required' })
  role!: ProjectMemberRole;
}

export class QueryProjectMembersDto {
  @ApiPropertyOptional({
    description: 'Filter project members by role',
    enum: ProjectMemberRole,
  })
  @IsEnum(ProjectMemberRole)
  @IsOptional()
  role?: ProjectMemberRole;

  @ApiPropertyOptional({
    description: 'Search string to match user name or email',
  })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({
    description: 'Pagination page number',
    default: 1,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({
    description: 'Pagination limit count',
    default: 50,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @IsOptional()
  limit?: number;
}
