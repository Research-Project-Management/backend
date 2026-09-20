import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectPriority } from '@prisma/client';

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
    description: 'Initial project state ID',
    example: '01957c91-2345-7890-abcd-ef0123456789',
  })
  @IsUUID('all')
  @IsOptional()
  stateId?: string;

  @ApiPropertyOptional({
    description: 'Project strategic priority',
    enum: ProjectPriority,
    default: ProjectPriority.none,
    example: ProjectPriority.high,
  })
  @IsEnum(ProjectPriority)
  @IsOptional()
  priority?: ProjectPriority;

  @ApiPropertyOptional({
    description: 'Start date of the project (YYYY-MM-DD)',
    example: '2026-10-01',
  })
  @IsDateString()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'Target / due date of the project (YYYY-MM-DD)',
    example: '2026-12-31',
  })
  @IsDateString()
  @IsOptional()
  targetDate?: string;

  @ApiPropertyOptional({
    description: 'List of ProjectLabel IDs to attach upon creation',
    example: ['11111111-2222-3333-4444-555555555555'],
  })
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  labelIds?: string[];

  @ApiPropertyOptional({
    description: 'Optional ProjectTemplate ID used to spawn this project',
  })
  @IsUUID('4')
  @IsOptional()
  templateId?: string;

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
    description: 'Detailed description or abstract of the project',
    example:
      'Investigating transformer architectures applied to genetic sequences.',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    description:
      'List of enabled feature modules in this project (work_items, cycles, views, pages)',
    example: ['work_items', 'cycles', 'views', 'pages'],
    default: ['work_items', 'cycles', 'views', 'pages'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  modules?: string[];

  @ApiPropertyOptional({
    description: 'Whether project is private',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  isPrivate?: boolean;
}
