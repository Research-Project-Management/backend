import {
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { WorkspaceMemberRole } from '@prisma/client';

export class CreateWorkspaceDto {
  @IsString()
  @IsNotEmpty({ message: 'Workspace name is required' })
  name!: string;

  @IsString()
  @IsOptional()
  url?: string;

  @IsString()
  @IsOptional()
  slug?: string;

  @IsString()
  @IsOptional()
  avatar?: string;

  @IsString()
  @IsOptional()
  companySize?: string;

  @IsString()
  @IsOptional()
  size?: string;

  @IsString()
  @IsOptional()
  timezone?: string;

  @IsString()
  @IsOptional()
  plan?: string;

  @IsObject()
  @IsOptional()
  settings?: Record<string, unknown>;
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
  slug?: string;

  @IsString()
  @IsOptional()
  avatar?: string;

  @IsString()
  @IsOptional()
  companySize?: string;

  @IsString()
  @IsOptional()
  size?: string;

  @IsString()
  @IsOptional()
  timezone?: string;

  @IsString()
  @IsOptional()
  plan?: string;

  @IsObject()
  @IsOptional()
  settings?: Record<string, unknown>;
}

export class AddWorkspaceMemberDto {
  @IsString()
  @IsOptional()
  userId?: string;

  @IsString()
  @IsOptional()
  email?: string;

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

export class CreateWorkspaceInvitationDto {
  @IsEmail({}, { message: 'A valid email address is required' })
  @IsNotEmpty({ message: 'Email is required' })
  email!: string;

  @IsEnum(WorkspaceMemberRole, {
    message: 'Role must be one of: owner, admin, member, viewer',
  })
  @IsOptional()
  role?: WorkspaceMemberRole;

  @IsInt()
  @Min(1)
  @Max(30)
  @IsOptional()
  expiresInDays?: number;
}
