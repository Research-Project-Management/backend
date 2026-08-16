import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateProjectDto {
  @IsString()
  @IsNotEmpty({ message: 'Project name is required' })
  name!: string;

  @IsString()
  @IsOptional()
  avatar?: string;

  @IsString()
  @IsOptional()
  description?: string;

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
  avatar?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsArray()
  @IsOptional()
  modules?: string[];

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsOptional()
  settings?: any;
}

export class AddProjectMemberDto {
  @IsString()
  @IsNotEmpty({ message: 'User ID is required' })
  userId!: string;

  @IsString()
  @IsOptional()
  role?: 'owner' | 'admin' | 'member' | 'viewer';
}

export class UpdateProjectMemberDto {
  @IsString()
  @IsNotEmpty({ message: 'Role is required' })
  role!: 'owner' | 'admin' | 'member' | 'viewer';

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
