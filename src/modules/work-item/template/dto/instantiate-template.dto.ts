import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TaskPriority } from '@prisma/client';

export class InstantiateTemplateDto {
  @ApiPropertyOptional({
    description: 'Override title for the created work item',
    example: '[BUG] Authentication failure on Safari iOS',
  })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({
    description: 'Override rich text / Markdown content',
  })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({
    description: 'Board column / state ID for the created work item',
    example: 'todo',
  })
  @IsOptional()
  @IsString()
  columnId?: string;

  @ApiPropertyOptional({
    description: 'Sprint cycle ID to assign the work item to',
  })
  @IsOptional()
  @IsString()
  cycleId?: string;

  @ApiPropertyOptional({
    description: 'Primary assignee user ID',
  })
  @IsOptional()
  @IsString()
  assigneeId?: string;

  @ApiPropertyOptional({
    description: 'Array of co-assignee user IDs',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  assigneeIds?: string[];

  @ApiPropertyOptional({
    enum: TaskPriority,
    description: 'Override priority',
  })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;
}
