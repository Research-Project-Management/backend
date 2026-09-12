import {
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BaseAttachmentMetadataDto } from './create-attachment.dto';

export { BaseAttachmentMetadataDto };
export * from './presign-attachment.dto';
export * from './query-attachment.dto';

export class CreateAttachmentDto extends BaseAttachmentMetadataDto {
  @ApiPropertyOptional({ description: 'Filename', example: 'specs.pdf' })
  @IsOptional()
  @IsString()
  filename?: string;

  @ApiPropertyOptional({
    description: 'Legacy name alias for filename',
    example: 'specs.pdf',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({
    description: 'URL of the uploaded attachment',
    example: '/api/files/r2/...',
  })
  @IsNotEmpty()
  @IsString()
  url!: string;
}

// Backward compatibility alias
export const CreateWorkItemAttachmentDto = CreateAttachmentDto;
export type CreateWorkItemAttachmentDto = CreateAttachmentDto;

export class AttachPageDto {
  @ApiProperty({ description: 'Page ID', example: 'd3b07384-d113-4603-a417-cc2349e5d7a6' })
  @IsNotEmpty()
  @IsString()
  pageId!: string;

  @ApiPropertyOptional({ description: 'Page Title', example: 'Research Methodology Notes' })
  @IsOptional()
  @IsString()
  title?: string;
}

export class AttachPaperDto {
  @ApiProperty({ description: 'Paper ID', example: 'p-10.1103/PhysRevLett.116.061102' })
  @IsNotEmpty()
  @IsString()
  paperId!: string;

  @ApiPropertyOptional({ description: 'Paper Title', example: 'Observation of Gravitational Waves' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ description: 'Paper DOI', example: '10.1103/PhysRevLett.116.061102' })
  @IsOptional()
  @IsString()
  doi?: string;

  @ApiPropertyOptional({ description: 'BibTeX Citation Key', example: 'Abbott2016' })
  @IsOptional()
  @IsString()
  citationKey?: string;
}

export class AttachFileDto {
  @ApiProperty({ description: 'File Name', example: 'experiment_dataset.csv' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({ description: 'File URL', example: 'https://r2.flux.internal/attachments/...' })
  @IsNotEmpty()
  @IsString()
  url!: string;

  @ApiPropertyOptional({ description: 'Size in bytes', example: 1048576 })
  @IsOptional()
  size?: number | string;

  @ApiPropertyOptional({ description: 'MIME Type', example: 'text/csv' })
  @IsOptional()
  @IsString()
  type?: string;
}

export class AttachLinkDto {
  @ApiProperty({ description: 'Link Title', example: 'ArXiv Preprint' })
  @IsNotEmpty()
  @IsString()
  title!: string;

  @ApiProperty({ description: 'Link URL', example: 'https://arxiv.org/abs/2106.12345' })
  @IsNotEmpty()
  @IsString()
  url!: string;
}
