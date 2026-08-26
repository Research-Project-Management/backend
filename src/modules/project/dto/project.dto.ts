import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ProjectMemberRole } from '@prisma/client';

export class CreateProjectDto {
  @IsString()
  @IsNotEmpty({ message: 'Project name is required' })
  name!: string;

  @IsString()
  @IsOptional()
  @MaxLength(20, { message: 'Identifier cannot exceed 20 characters' })
  identifier?: string;

  @IsString()
  @IsOptional()
  avatar?: string;

  @IsString()
  @IsOptional()
  coverImage?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  leadId?: string;

  @IsArray()
  @IsOptional()
  modules?: string[];

  @IsString()
  @IsOptional()
  workspaceId?: string;
}

export class UpdateProjectDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20, { message: 'Identifier cannot exceed 20 characters' })
  identifier?: string;

  @IsString()
  @IsOptional()
  avatar?: string;

  @IsString()
  @IsOptional()
  coverImage?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  leadId?: string;

  @IsArray()
  @IsOptional()
  modules?: string[];

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsOptional()
  settings?: any;

  @IsOptional()
  taskColumns?: any;
}

export class AddProjectMemberDto {
  @IsString()
  @IsNotEmpty({ message: 'User ID is required' })
  userId!: string;

  @IsEnum(ProjectMemberRole, { message: 'Invalid project member role' })
  @IsOptional()
  role?: ProjectMemberRole;
}

export class UpdateProjectMemberDto {
  @IsEnum(ProjectMemberRole, { message: 'Invalid project member role' })
  @IsNotEmpty({ message: 'Role is required' })
  role!: ProjectMemberRole;

  @IsString()
  @IsOptional()
  userId?: string;
}

export class AddColumnDto {
  @IsString()
  @IsNotEmpty({ message: 'Column title is required' })
  title!: string;

  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsOptional()
  accentColor?: string;
}

export class UpdateColumnDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  accentColor?: string;
}
