import {
  IsArray,
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

  @IsNumber()
  @IsOptional()
  estimate?: number;

  @IsNumber()
  @IsOptional()
  rank?: number;

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

  @IsArray()
  @IsOptional()
  attachments?: Prisma.InputJsonValue;

  @IsString()
  @IsOptional()
  recurrence?: string;

  @IsString()
  @IsOptional()
  reminder?: string;

  @IsNumber()
  @IsOptional()
  timeSpent?: number;
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

  @IsNumber()
  @IsOptional()
  estimate?: number;

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

  @IsArray()
  @IsOptional()
  attachments?: Prisma.InputJsonValue;

  @IsNumber()
  @IsOptional()
  rank?: number;

  @IsString()
  @IsOptional()
  recurrence?: string;

  @IsString()
  @IsOptional()
  reminder?: string;

  @IsNumber()
  @IsOptional()
  timeSpent?: number;

  @IsOptional()
  completed?: boolean;
}

export class AssignTaskDto {
  @IsString()
  @IsNotEmpty({ message: 'Assignee ID is required' })
  assignee!: string;
}

export class ReorderTaskDto {
  @IsNumber()
  @IsOptional()
  sourceIndex?: number;

  @IsNumber()
  @IsOptional()
  destinationIndex?: number;

  @IsString()
  @IsOptional()
  sourceColumnId?: string;

  @IsString()
  @IsOptional()
  destinationColumnId?: string;

  @IsString()
  @IsOptional()
  taskId?: string;

  @IsString()
  @IsOptional()
  columnId?: string;

  @IsNumber()
  @IsOptional()
  rank?: number;
}

export class BulkUpdateTaskDto {
  @IsArray()
  @IsNotEmpty()
  taskIds!: string[];

  @IsObject()
  data!: {
    columnId?: string;
    assigneeId?: string | null;
    priority?: TaskPriority | (string & {});
    cycleId?: string | null;
    [key: string]: any;
  };
}
