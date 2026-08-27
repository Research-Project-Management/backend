import { IsString, IsNotEmpty, IsOptional, IsEnum } from 'class-validator';

export class CreateZoteroConnectionDto {
  @IsString()
  @IsNotEmpty()
  apiKey!: string;

  @IsString()
  @IsOptional()
  accountName?: string;

  @IsString()
  @IsOptional()
  zoteroUserId?: string;

  @IsEnum(['user', 'group'])
  @IsOptional()
  accountType?: 'user' | 'group';
}

export class CreateZoteroBindingDto {
  @IsString()
  @IsNotEmpty()
  connectionId!: string;

  @IsEnum(['user', 'group'])
  @IsOptional()
  remoteLibraryType?: 'user' | 'group';

  @IsString()
  @IsNotEmpty()
  remoteLibraryId!: string;

  @IsEnum(['read_only', 'two_way'])
  @IsOptional()
  syncDirection?: 'read_only' | 'two_way';
}

export interface ZoteroConnectionView {
  id: string;
  workspaceId: string;
  userId: string;
  provider: string;
  accountName: string | null;
  accountType: string | null;
  zoteroUserId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}
