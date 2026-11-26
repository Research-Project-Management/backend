import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUrl,
  MaxLength,
} from 'class-validator';

export class ImportSummaryResponseDto {
  @ApiProperty()
  projectId!: string;

  @ApiProperty()
  totalEntries!: number;

  @ApiProperty()
  totalDocs!: number;

  @ApiProperty()
  totalFiles!: number;

  @ApiProperty()
  totalFolders!: number;

  @ApiPropertyOptional({ nullable: true })
  rootDocId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  rootDocPath!: string | null;
}

export class ImportUrlDto {
  @ApiProperty({ description: 'External HTTP/HTTPS URL to fetch and import' })
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @IsNotEmpty()
  @MaxLength(2048)
  url!: string;

  @ApiPropertyOptional({ description: 'Target filename inside the project' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;

  @ApiPropertyOptional({ description: 'Target Page ID scope' })
  @IsOptional()
  @IsString()
  pageId?: string;
}
