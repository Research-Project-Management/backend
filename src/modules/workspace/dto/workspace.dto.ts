import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { WorkspaceMemberRole } from '@prisma/client';

export class CreateWorkspaceDto {
  @IsString()
  @IsNotEmpty({ message: 'Workspace name is required' })
  name!: string;

  @IsString()
  @IsNotEmpty({ message: 'Workspace URL is required' })
  url!: string;

  @IsString()
  @IsOptional()
  avatar?: string;

  @IsString()
  @IsOptional()
  companySize?: string;
}

export class UpdateWorkspaceDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  url?: string;

  @IsString()
  @IsOptional()
  avatar?: string;

  @IsString()
  @IsOptional()
  companySize?: string;
}

export class AddWorkspaceMemberDto {
  @IsString()
  @IsNotEmpty({ message: 'User ID or Email is required' })
  userId!: string;

  @IsEnum(WorkspaceMemberRole, {
    message: 'Role must be one of: owner, admin, member, viewer',
  })
  @IsOptional()
  role?: WorkspaceMemberRole;
}

export class UpdateWorkspaceMemberDto {
  @IsEnum(WorkspaceMemberRole, {
    message: 'Role must be one of: owner, admin, member, viewer',
  })
  @IsNotEmpty({ message: 'Role is required' })
  role!: WorkspaceMemberRole;

  @IsString()
  @IsOptional()
  userId?: string;
}

export class JoinWorkspaceDto {
  @IsString()
  @IsNotEmpty({ message: 'Invite code is required' })
  inviteCode!: string;
}
