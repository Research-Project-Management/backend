import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for creating a new project.
 * The creator automatically becomes the project 'owner'.
 */
export class CreateProjectDto {
  @ApiProperty({
    description: 'Display name of the project',
    example: 'Deep Learning for Genome Analysis',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty({ message: 'Project name is required' })
  @MaxLength(100, { message: 'Project name cannot exceed 100 characters' })
  name!: string;

  @ApiPropertyOptional({
    description:
      'Short unique identifier/key for project WorkItem codes (e.g. DLGA)',
    example: 'DLGA',
    maxLength: 12,
  })
  @IsString()
  @IsOptional()
  @MaxLength(12, { message: 'Identifier cannot exceed 12 characters' })
  @Matches(/^[A-Z0-9_-]+$/, {
    message:
      'Identifier must contain uppercase letters, numbers, hyphens or underscores',
  })
  identifier?: string;

  @ApiPropertyOptional({
    description: 'Project avatar image URL or emoji icon',
    example: '🧬',
  })
  @IsString()
  @IsOptional()
  avatar?: string;

  @ApiPropertyOptional({
    description: 'Project header banner image URL',
    example: 'https://example.com/covers/project-bg.png',
  })
  @IsString()
  @IsOptional()
  coverImage?: string;

  @ApiPropertyOptional({
    description: 'Alias for coverImage',
    example: 'https://example.com/covers/project-bg.png',
  })
  @IsString()
  @IsOptional()
  cover?: string;

  @ApiPropertyOptional({
    description: 'Whether the project is private to assigned collaborators',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  isPrivate?: boolean;

  @ApiPropertyOptional({
    description: 'Primary timezone of the project team',
    example: 'Asia/Ho_Chi_Minh',
  })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional({
    description: 'Detailed description or abstract of the project',
    example:
      'Investigating transformer architectures applied to genetic sequences.',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    description: 'List of enabled feature modules in this project',
    example: ['overview', 'work_items', 'pages'],
    default: ['overview', 'work_items', 'pages'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  modules?: string[];
}
