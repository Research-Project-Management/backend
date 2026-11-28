import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class SyncCollectionDto {
  @IsNotEmpty()
  @IsString()
  pageId!: string;

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
