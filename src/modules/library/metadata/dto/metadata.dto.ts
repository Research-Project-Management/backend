import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CreatorInput as LibraryCreatorInput } from '../types/metadata.types';

export class ResolveQueryDto {
  @ApiProperty({
    description:
      'Academic query string (DOI, arXiv ID, arXiv URL, DOI URL, or Title)',
    example: '1706.03762',
  })
  @IsString()
  @IsNotEmpty()
  query!: string;
}

export class ResolveDoiDto {
  @ApiProperty({
    description: 'DOI identifier (e.g. 10.1038/s41586-020-2649-2 or full URL)',
    example: '10.1038/s41586-020-2649-2',
  })
  @IsString()
  @IsNotEmpty()
  doi!: string;
}

export class NormalizeMetadataDto {
  @ApiPropertyOptional({
    description:
      'Item type label/key to normalize (e.g. Journal Article, journalArticle)',
  })
  @IsString()
  @IsOptional()
  itemType?: string | null;

  @ApiPropertyOptional({
    description:
      'Reference-Manager-style creators to normalize into authors/editors/otherCreators',
  })
  @IsArray()
  @IsOptional()
  creators?: LibraryCreatorInput[] | null;

  @ApiPropertyOptional({ description: 'Tags/labels to trim and dedupe' })
  @IsArray()
  @IsOptional()
  tags?: Array<string | null | undefined> | null;

  @ApiPropertyOptional({
    description: 'Publication date string for year extraction',
  })
  @IsString()
  @IsOptional()
  date?: string | null;
}
