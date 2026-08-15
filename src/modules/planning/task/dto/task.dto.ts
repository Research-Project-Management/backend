import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import { TaskPriority, Prisma } from '@prisma/client';

export class CreateTaskDto {
  @IsString()
  @IsNotEmpty({ message: 'Task title is required' })
  title!: string;

  @IsString()
  @IsOptional()
  content?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsNotEmpty({ message: 'Column ID is required' })
  columnId!: string;

  @IsString()
  @IsOptional()
  assignee?: string;

  @IsString()
  @IsOptional()
  assigneeId?: string;

  @IsOptional()
  startDate?: string | Date;

  @IsOptional()
  dueDate?: string | Date;

  @IsEnum(TaskPriority)
  @IsOptional()
  priority?: TaskPriority;

  @IsString()
  @IsOptional()
  cycle?: string;

  @IsString()
  @IsOptional()
  cycleId?: string;

  @IsString()
  @IsOptional()
  parentTask?: string;

  @IsString()
  @IsOptional()
  parentTaskId?: string;

  @IsArray()
  @IsOptional()
  labels?: string[];

  @IsArray()
  @IsOptional()
  checklists?: Prisma.InputJsonValue;
}

export class UpdateTaskDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  content?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  columnId?: string;

  @IsString()
  @IsOptional()
  assignee?: string | null;

  @IsString()
  @IsOptional()
  assigneeId?: string | null;

  @IsOptional()
  startDate?: string | Date;

  @IsOptional()
  dueDate?: string | Date;

  @IsEnum(TaskPriority)
  @IsOptional()
  priority?: TaskPriority;

  @IsString()
  @IsOptional()
  cycle?: string | null;

  @IsString()
  @IsOptional()
  cycleId?: string | null;

  @IsString()
  @IsOptional()
  parentTask?: string | null;

  @IsString()
  @IsOptional()
  parentTaskId?: string | null;

  @IsArray()
  @IsOptional()
  labels?: string[];

  @IsArray()
  @IsOptional()
  checklists?: Prisma.InputJsonValue;

  @IsBoolean()
  @IsOptional()
  completed?: boolean;

  @IsNumber()
  @IsOptional()
  rank?: number;
}

export class AssignTaskDto {
  @IsString()
  @IsNotEmpty({ message: 'Assignee ID is required' })
  assignee!: string;
}

export class ReorderTaskDto {
  @IsNumber()
  sourceIndex!: number;

  @IsNumber()
  destinationIndex!: number;

  @IsString()
  @IsNotEmpty()
  sourceColumnId!: string;

  @IsString()
  @IsNotEmpty()
  destinationColumnId!: string;
}

export class BulkUpdateTaskDto {
  @IsArray()
  @IsNotEmpty()
  taskIds!: string[];

  @IsObject()
  data!: Record<string, unknown>;
}
