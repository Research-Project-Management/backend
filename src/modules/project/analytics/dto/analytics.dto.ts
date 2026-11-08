import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsArray,
  IsObject,
  IsOptional,
} from 'class-validator';
import {
  AssigneeDistributionItem,
  LabelDistributionItem,
  StateColumnBreakdownItem,
} from '../types/analytics.types';

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
  inProgressItems!: number;

  @ApiProperty()
  @IsNumber()
  overdueItems!: number;

  @ApiProperty()
  @IsNumber()
  unassignedItems!: number;

  @ApiProperty()
  @IsNumber()
  completionRate!: number;

  @ApiProperty()
  @IsObject()
  state!: Record<string, number>;

  @ApiProperty()
  @IsObject()
  stateGroups!: Record<string, number>;

  @ApiProperty()
  @IsArray()
  states!: StateColumnBreakdownItem[];

  @ApiProperty()
  @IsObject()
  priority!: Record<string, number>;

  @ApiProperty()
  @IsArray()
  assignee!: AssigneeDistributionItem[];

  @ApiProperty()
  @IsArray()
  labels!: LabelDistributionItem[];
}

export { YourWorkSummaryDto } from '../../your-work/dto/your-work.dto';
