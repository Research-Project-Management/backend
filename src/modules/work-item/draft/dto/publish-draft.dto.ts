import { IsOptional, IsString, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TaskPriority } from '@prisma/client';

export class PublishDraftDto {
  @ApiPropertyOptional({ description: 'Target project ID if not previously set on draft' })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Override column/state ID upon publishing' })
  @IsOptional()
  @IsString()
  columnId?: string;

  @ApiPropertyOptional({ description: 'Override cycle ID upon publishing' })
  @IsOptional()
  @IsString()
  cycleId?: string;

  @ApiPropertyOptional({ description: 'Override title upon publishing' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ enum: TaskPriority })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;
}
