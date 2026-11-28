import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PresignChatAttachmentDto {
  @ApiProperty({
    description: 'Original filename',
    example: 'quantum_paper.pdf',
  })
  @IsString()
  @IsNotEmpty()
  filename!: string;

  @ApiProperty({
    description: 'File size in bytes',
    example: 1048576,
  })
  @IsNumber()
  @Min(1, { message: 'File size must be greater than 0' })
  sizeBytes!: number;

  @ApiPropertyOptional({
    description: 'MIME type of the file',
    example: 'application/pdf',
  })
  @IsString()
  @IsOptional()
  mimeType?: string;
}

export class CompleteChatAttachmentDto {
  @ApiProperty({
    description: 'Storage key returned during presigning',
    example: 'chat/conv-123/2026/11/abc-123-quantum_paper.pdf',
  })
  @IsString()
  @IsNotEmpty()
  storageKey!: string;

  @ApiProperty({
    description: 'Original filename',
    example: 'quantum_paper.pdf',
  })
  @IsString()
  @IsNotEmpty()
  filename!: string;

  @ApiProperty({
    description: 'File size in bytes',
    example: 1048576,
  })
  @IsNumber()
  @Min(1)
  sizeBytes!: number;

  @ApiPropertyOptional({
    description: 'MIME type of the file',
    example: 'application/pdf',
  })
  @IsString()
  @IsOptional()
  mimeType?: string;
}
