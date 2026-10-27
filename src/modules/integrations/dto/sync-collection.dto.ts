import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

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
  @Matches(/^[\w.-]+\.bib$/, {
    message:
      'targetBibFile must be a valid .bib filename without path traversal',
  })
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

