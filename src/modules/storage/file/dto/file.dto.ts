import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

export class PresignDto {
  @IsString()
  @IsNotEmpty({ message: 'Filename is required' })
  filename!: string;

  @IsString()
  @IsOptional()
  mimeType?: string;
}

export class UploadFileDto {
  @IsString()
  @IsNotEmpty({ message: 'Filename is required' })
  filename!: string;

  @IsNumber()
  @IsOptional()
  size?: number;

  @IsString()
  @IsOptional()
  mimeType?: string;

  @IsString()
  @IsOptional()
  url?: string;

  @IsString()
  @IsOptional()
  thumbnail?: string;

  @IsString()
  @IsOptional()
  parentId?: string;

  @IsObject()
  @IsOptional()
  metaData?: Record<string, unknown>;

  @IsString()
  @IsOptional()
  workspaceId?: string;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  pageId?: string;
}

export class CreateFolderDto {
  @IsString()
  @IsOptional()
  filename?: string;

  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  parentId?: string;

  @IsString()
  @IsOptional()
  workspaceId?: string;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  pageId?: string;
}

export class UpdateFileDto {
  @IsString()
  @IsOptional()
  filename?: string;

  @IsBoolean()
  @IsOptional()
  starred?: boolean;

  @IsString()
  @IsOptional()
  parentId?: string;

  @IsObject()
  @IsOptional()
  metaData?: Record<string, unknown>;
}

export class RenameFileDto {
  @IsString()
  @IsOptional()
  filename?: string;

  @IsString()
  @IsOptional()
  name?: string;
}

export class MoveFileDto {
  @IsString()
  @IsOptional()
  parentId?: string;
}

export class ShareFileDto {
  @IsString()
  @IsNotEmpty({ message: 'User ID is required' })
  userId!: string;

  @IsString()
  @IsOptional()
  permission?: 'view' | 'edit';
}
