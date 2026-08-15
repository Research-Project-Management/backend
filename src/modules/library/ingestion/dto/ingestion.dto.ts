import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsArray,
  IsNumber,
  IsBoolean,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export enum IngestionSourceType {
  DOI = 'doi',
  BIBTEX = 'bibtex',
  PDF = 'pdf',
  STORAGE = 'storage',
}

export class IngestDocumentDto {
  @ApiProperty({ description: 'Workspace ID where document belongs' })
  @IsString()
  @IsNotEmpty()
  workspaceId!: string;

  @ApiProperty({
    description: 'Source Type of ingestion',
    enum: IngestionSourceType,
    example: IngestionSourceType.DOI,
  })
  @IsEnum(IngestionSourceType)
  @IsNotEmpty()
  sourceType!: IngestionSourceType;

  @ApiPropertyOptional({
    description: 'DOI string (e.g. 10.1145/3377325.3377498)',
  })
  @IsString()
  @IsOptional()
  doi?: string;

  @ApiPropertyOptional({ description: 'Raw BibTeX text string' })
  @IsString()
  @IsOptional()
  bibtex?: string;

  @ApiPropertyOptional({ description: 'Direct PDF URL or asset link' })
  @IsString()
  @IsOptional()
  fileUrl?: string;

  @ApiPropertyOptional({
    description: 'Storage File ID if already uploaded to storage',
  })
  @IsString()
  @IsOptional()
  storageFileId?: string;

  @ApiPropertyOptional({ description: 'Document Title override' })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ description: 'Authors array', type: [String] })
  @IsArray()
  @IsOptional()
  authors?: string[];

  @ApiPropertyOptional({ description: 'Publication year' })
  @IsNumber()
  @IsOptional()
  year?: number;

  @ApiPropertyOptional({ description: 'Journal, conference, or publisher' })
  @IsString()
  @IsOptional()
  journal?: string;

  @ApiPropertyOptional({
    description: 'Target Collection ID to place document in',
  })
  @IsString()
  @IsOptional()
  collectionId?: string;

  @ApiPropertyOptional({ description: 'Tags array', type: [String] })
  @IsArray()
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({
    description: 'Whether to trigger background vector RAG indexing',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  triggerRag?: boolean;
}

export class BatchIngestDto {
  @ApiProperty({
    description: 'Array of ingestion payloads',
    type: [IngestDocumentDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => IngestDocumentDto)
  items!: IngestDocumentDto[];
}
