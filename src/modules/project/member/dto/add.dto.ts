import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  ArrayMinSize,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectMemberRole } from '@prisma/client';

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
      'Role to assign in the project. Defaults to contributor (assignable: contributor, commenter, viewer).',
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
