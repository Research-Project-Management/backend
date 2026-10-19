import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class SyncCollectionDto {
  @IsNotEmpty()
  @IsString()
  projectId!: string;

  @IsNotEmpty()
  @IsString()
  collectionId!: string;

  @IsOptional()
  @IsString()
  collectionName?: string;

  @IsOptional()
  @IsString()
  targetBibFile?: string;
}

export class SyncLibraryCollectionDto {
  @IsNotEmpty()
  @IsString()
  collectionId!: string;

  @IsOptional()
  @IsString()
  collectionName?: string;

  @IsOptional()
  @IsString()
  targetCollectionId?: string;

  @IsOptional()
  @IsString()
  projectId?: string;
}

