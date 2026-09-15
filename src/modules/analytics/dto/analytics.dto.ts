import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsString,
  IsBoolean,
  IsArray,
  IsObject,
  IsOptional,
} from 'class-validator';

export class ProjectOverviewDto {
  @ApiProperty()
  @IsNumber()
  members!: number;

  @ApiProperty()
  @IsNumber()
  workItems!: number;

  @ApiProperty()
  @IsNumber()
  pages!: number;

  @ApiProperty()
  @IsNumber()
  files!: number;

  @ApiProperty()
  @IsNumber()
  stickies!: number;

  @ApiProperty()
  @IsNumber()
  cycles!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  papers?: number;
}

export class UserOverviewDto {
  @ApiProperty()
  @IsNumber()
  projects!: number;

  @ApiProperty()
  @IsNumber()
  assignedWorkItems!: number;

  @ApiProperty()
  @IsNumber()
  createdWorkItems!: number;

  @ApiProperty()
  @IsNumber()
  pages!: number;

  @ApiProperty()
  @IsNumber()
  stickies!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  papers?: number;
}

export class ProjectWorkItemDistributionDto {
  @ApiProperty()
  @IsNumber()
  totalItems!: number;

  @ApiProperty()
  @IsNumber()
  completedItems!: number;

  @ApiProperty()
  @IsNumber()
  completionRate!: number;

  @ApiProperty()
  @IsObject()
  state!: Record<string, number>;

  @ApiProperty()
  @IsObject()
  priority!: Record<string, number>;

  @ApiProperty()
  @IsArray()
  assignee!: Array<{
    userId: string;
    name: string;
    avatar: string | null;
    count: number;
  }>;
}

export class CycleAnalyticsDto {
  @ApiProperty()
  @IsString()
  cycleId!: string;

  @ApiProperty()
  @IsNumber()
  totalWorkItems!: number;

  @ApiProperty()
  @IsNumber()
  completedWorkItems!: number;

  @ApiProperty()
  @IsNumber()
  inProgressWorkItems!: number;

  @ApiProperty()
  @IsNumber()
  pendingWorkItems!: number;

  @ApiProperty()
  @IsNumber()
  completionRate!: number;
}

export { YourWorkSummaryDto } from '../your-work/dto/your-work.dto';
