import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

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
  pageId?: string;
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

export class BatchFileIdsDto {
  @IsNotEmpty({ message: 'File IDs array is required' })
  ids!: string[];
}

export class BatchStarDto {
  @IsNotEmpty({ message: 'File IDs array is required' })
  ids!: string[];

  @IsBoolean()
  starred!: boolean;
}
