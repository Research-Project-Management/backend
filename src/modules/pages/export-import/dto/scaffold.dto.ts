import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';

export class ScaffoldTemplateDto {
  @ApiPropertyOptional({
    description:
      'Identifier of the academic template (e.g., ieee-transactions, acm-sigconf)',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  templateId?: string;

  @ApiPropertyOptional({ description: 'Optional Page scope ID' })
  @IsOptional()
  @IsString()
  pageId?: string;
}
