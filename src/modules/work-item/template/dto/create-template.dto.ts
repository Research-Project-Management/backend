import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsBoolean,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TaskPriority } from '@prisma/client';

export class CreateTemplateDto {
  @ApiProperty({
    description: 'Name of the template',
    example: 'Standard Bug Report',
    maxLength: 255,
  })
  @IsString()
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({
    description: 'Brief description of when to use this template',
    example: 'Use this template to report frontend or backend software defects',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Pre-populated task title template',
    example: '[BUG] ',
  })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({
    description: 'Pre-populated rich text / Markdown content structure',
    example: '### Steps to Reproduce\n1. \n2. \n\n### Expected Behavior\n\n### Actual Behavior\n\n### Environment',
  })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({
    enum: TaskPriority,
    description: 'Default priority level',
    default: TaskPriority.none,
  })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @ApiPropertyOptional({
    description: 'Array of default label IDs to apply',
    type: [String],
    example: ['11111111-1111-1111-1111-111111111111'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  labelIds?: string[];

  @ApiPropertyOptional({
    description: 'Array of default co-assignee user IDs',
    type: [String],
    example: ['22222222-2222-2222-2222-222222222222'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  assigneeIds?: string[];

  @ApiPropertyOptional({
    description: 'Array of default checklist items',
    example: [{ title: 'Verify reproduce steps', completed: false }],
  })
  @IsOptional()
  @IsArray()
  checklists?: any[];

  @ApiPropertyOptional({
    description: 'Whether this template is the default template for the project',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({
    description: 'Optional Project ID (if not provided via URL parameter)',
  })
  @IsOptional()
  @IsString()
  projectId?: string;
}
