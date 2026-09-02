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
  cover?: string;

  @IsBoolean()
  @IsOptional()
  isPrivate?: boolean;

  @IsString()
  @IsOptional()
  timezone?: string;

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
  projectId?: string;

  @IsString()
  @IsOptional()
  workspaceId?: string;

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
  cover?: string;

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

  @IsBoolean()
  @IsOptional()
  isArchived?: boolean;

  @IsBoolean()
  @IsOptional()
  isFavorite?: boolean;

  @IsBoolean()
  @IsOptional()
  isPrivate?: boolean;

  @IsString()
  @IsOptional()
  timezone?: string;

  @IsArray()
  @IsOptional()
  subscriberIds?: string[];

  @IsString()
  @IsOptional()
  role?: string;

  @IsString()
  @IsOptional()
  newRole?: string;

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
  @IsOptional()
  role?: ProjectMemberRole;

  @IsString()
  @IsOptional()
  newRole?: string;

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

export class ReorderColumnsDto {
  @IsArray()
  @IsNotEmpty({ message: 'Columns list is required' })
  columns!: Array<{
    id: string;
    title: string;
    isDefault?: boolean;
    accentColor?: string;
  }>;
}
