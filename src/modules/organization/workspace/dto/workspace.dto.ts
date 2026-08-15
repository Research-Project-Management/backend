import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

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

  @IsString()
  @IsOptional()
  role?: 'owner' | 'admin' | 'member' | 'viewer';
}

export class UpdateWorkspaceMemberDto {
  @IsString()
  @IsNotEmpty({ message: 'Role is required' })
  role!: 'owner' | 'admin' | 'member' | 'viewer';

  @IsString()
  @IsOptional()
  userId?: string;
}

export class JoinWorkspaceDto {
  @IsString()
  @IsNotEmpty({ message: 'Invite code is required' })
  inviteCode!: string;
}
