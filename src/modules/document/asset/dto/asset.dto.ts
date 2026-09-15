import { IsString, IsNotEmpty, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UploadAssetDto {
  @ApiProperty({
    description:
      'Asset file name (e.g. architecture.png, logo.svg, dataset.csv)',
  })
  @IsString()
  @IsNotEmpty({ message: 'Filename is required' })
  filename!: string;

  @ApiProperty({ description: 'Base64-encoded binary content of the file' })
  @IsString()
  @IsNotEmpty({ message: 'Base64 content is required' })
  contentBase64!: string;

  @ApiPropertyOptional({
    description: 'MIME type of the asset (e.g. image/png, application/pdf)',
  })
  @IsString()
  @IsOptional()
  mimeType?: string;

  @ApiPropertyOptional({
    description: 'Relative path in project workspace (e.g. figures/arch.png)',
  })
  @IsString()
  @IsOptional()
  path?: string;

  @ApiPropertyOptional({
    description: 'Parent folder node ID in the document tree',
  })
  @IsOptional()
  @IsUUID()
  parentPageId?: string;
}

export interface DocumentAssetItem {
  id: string;
  filename: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  contentBase64?: string;
  projectId: string;
  parentPageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
