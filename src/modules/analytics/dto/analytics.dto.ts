import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class WorkspaceStatsResponse {
  @ApiProperty()
  members!: number;

  @ApiProperty()
  projects!: number;

  @ApiProperty()
  tasks!: number;

  @ApiProperty()
  papers!: number;

  @ApiProperty()
  pages!: number;

  @ApiProperty()
  files!: number;

  @ApiProperty()
  stickies!: number;
}

export class ProjectTaskDistributionDto {
  @ApiProperty()
  state!: Record<string, number>;

  @ApiProperty()
  priority!: Record<string, number>;

  @ApiProperty()
  assignee!: Array<{
    userId: string;
    name: string;
    avatar: string | null;
    count: number;
  }>;
}

export class CycleAnalyticsDto {
  @ApiProperty()
  cycleId!: string;

  @ApiProperty()
  totalTasks!: number;

  @ApiProperty()
  completedTasks!: number;

  @ApiProperty()
  inProgressTasks!: number;

  @ApiProperty()
  pendingTasks!: number;

  @ApiProperty()
  completionRate!: number;
}

export class YourWorkSummaryDto {
  @ApiProperty()
  workspaceId!: string;

  @ApiProperty()
  userId!: string;

  @ApiProperty()
  assigned!: any[];

  @ApiProperty()
  created!: any[];

  @ApiProperty()
  subscribed!: any[];

  @ApiProperty()
  activity!: any[];

  @ApiProperty()
  recent!: any[];

  @ApiProperty()
  success!: boolean;
}
