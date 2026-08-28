import {
  IsString,
  IsOptional,
  IsInt,
  Min,
  Max,
  MaxLength,
  IsArray,
  ArrayMaxSize,
} from 'class-validator';

export class ResolveZoteroConflictDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  abstract?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  abstractNote?: string;

  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(2100)
  year?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  doi?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  publicationTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  volume?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  issue?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  pages?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  issn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  isbn?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  tags?: string[];
}
