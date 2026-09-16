import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class InitialWorkItemDto {
  @ApiProperty({ example: 'Sprint 0 Setup & Backlog grooming' })
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ApiPropertyOptional({ example: 'Initial setup tasks for repo, CI/CD, and docs' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ example: 'high' })
  @IsString()
  @IsOptional()
  priority?: string;
}

export class InitialStateDto {
  @ApiProperty({ example: 'backlog' })
  @IsString()
  @IsNotEmpty()
  group!: string; // backlog, unstarted, started, completed, cancelled

  @ApiProperty({ example: 'In Review' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ example: '#F59E0B' })
  @IsString()
  @IsOptional()
  color?: string;
}

export class InitialLabelDto {
  @ApiProperty({ example: 'Bug' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: '#EF4444' })
  @IsString()
  @IsNotEmpty()
  color!: string;
}

export class CreateProjectTemplateDto {
  @ApiProperty({
    description: 'Name of the project template',
    example: 'Agile Scrum Sprint Template',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty({ message: 'Template name is required' })
  @MaxLength(100, { message: 'Template name cannot exceed 100 characters' })
  name!: string;

  @ApiPropertyOptional({
    description: 'Detailed description of the template purpose and workflow',
    example: 'Template for 2-week agile sprint iterations with pre-configured review states and quality labels.',
    maxLength: 500,
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    description: 'Avatar emoji or icon for the template',
    example: '🚀',
  })
  @IsString()
  @IsOptional()
  avatar?: string;

  @ApiPropertyOptional({
    description: 'Cover image URL for the template',
    example: 'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4',
  })
  @IsString()
  @IsOptional()
  coverImage?: string;

  @ApiPropertyOptional({
    description: 'Whether this template is public / system-wide',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  isPublic?: boolean;

  @ApiPropertyOptional({
    description: 'Enabled feature modules in projects spawned from this template',
    example: ['work_items', 'cycles', 'views', 'pages'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  defaultModules?: string[];

  @ApiPropertyOptional({
    description: 'WorkItem states to automatically seed when creating a project from this template',
    type: [InitialStateDto],
  })
  @IsArray()
  @IsOptional()
  initialStates?: InitialStateDto[];

  @ApiPropertyOptional({
    description: 'WorkItem labels to automatically seed when creating a project from this template',
    type: [InitialLabelDto],
  })
  @IsArray()
  @IsOptional()
  initialLabels?: InitialLabelDto[];

  @ApiPropertyOptional({
    description: 'Initial checklist/tasks to create when initializing a project from this template',
    type: [InitialWorkItemDto],
  })
  @IsArray()
  @IsOptional()
  initialWorkItems?: InitialWorkItemDto[];
}
