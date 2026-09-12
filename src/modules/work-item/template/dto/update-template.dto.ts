import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsBoolean,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TaskPriority } from '@prisma/client';

export class UpdateTemplateDto {
  @ApiPropertyOptional({
    description: 'Updated name of the template',
    example: 'Standard Bug Report (v2)',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    description: 'Updated description of template usage',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Updated task title template',
    example: '[DEFECT] ',
  })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({
    description: 'Updated rich text / Markdown content structure',
  })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({
    enum: TaskPriority,
    description: 'Updated default priority level',
  })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @ApiPropertyOptional({
    description: 'Updated default label IDs',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  labelIds?: string[];

  @ApiPropertyOptional({
    description: 'Updated default co-assignee user IDs',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  assigneeIds?: string[];

  @ApiPropertyOptional({
    description: 'Updated checklist items',
  })
  @IsOptional()
  @IsArray()
  checklists?: any[];

  @ApiPropertyOptional({
    description: 'Whether this template is the default template for the project',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
