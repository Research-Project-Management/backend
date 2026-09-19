import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class InstantiateProjectTemplateDto {
  @ApiProperty({
    description: 'Name for the new project spawned from this template',
    example: 'GenAI Recommendation Engine',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty({ message: 'Project name is required' })
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    description:
      'Custom identifier/key for the new project (defaults to generated prefix)',
    example: 'GENAI',
    maxLength: 12,
  })
  @IsString()
  @IsOptional()
  @MaxLength(12)
  @Matches(/^[A-Z0-9_-]+$/, {
    message:
      'Identifier must contain uppercase letters, numbers, hyphens or underscores',
  })
  identifier?: string;

  @ApiPropertyOptional({
    description:
      'Custom description for the project (overrides template description if provided)',
    example:
      'Building production recommendation service using modern embeddings.',
  })
  @IsString()
  @IsOptional()
  description?: string;
}
