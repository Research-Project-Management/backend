import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateThreadDto {
  @IsString()
  @IsOptional()
  workspaceSlug?: string;

  @IsString()
  @IsOptional()
  workspaceId?: string;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  pageId?: string;

  @IsString()
  @IsOptional()
  title?: string;

  @IsArray()
  @IsOptional()
  messages?: Array<Record<string, unknown>>;

  @IsArray()
  @IsOptional()
  documentIds?: string[];
}

export class AppendMessagesDto {
  @IsArray()
  @IsNotEmpty({ message: 'Messages array is required' })
  messages!: Array<Record<string, unknown>>;

  @IsArray()
  @IsOptional()
  documentIds?: string[];

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  workspaceId?: string;
}

export class RenameThreadDto {
  @IsString()
  @IsNotEmpty({ message: 'Title is required' })
  title!: string;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  workspaceId?: string;
}
