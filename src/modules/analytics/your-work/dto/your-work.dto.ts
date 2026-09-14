import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsBoolean, IsArray, IsOptional } from 'class-validator';
import type {
  UserWorkItem,
  YourWorkActivityItem,
} from '../types/your-work.types';
import type { RecentItemResponse } from '@/modules/activity/dto/activity.dto';

export class YourWorkSummaryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiProperty()
  @IsString()
  userId!: string;

  @ApiProperty({ description: 'Work items assigned to the user' })
  @IsArray()
  assigned!: UserWorkItem[];

  @ApiProperty({ description: 'Work items created by the user' })
  @IsArray()
  created!: UserWorkItem[];

  @ApiProperty({ description: 'Work items subscribed by the user (commented on)' })
  @IsArray()
  subscribed!: UserWorkItem[];

  @ApiProperty({
    description: 'Formatted activity feed items for the project or user',
  })
  @IsArray()
  activity!: YourWorkActivityItem[];

  @ApiProperty({ description: 'Recently interacted items' })
  @IsArray()
  recent!: RecentItemResponse[];

  @ApiProperty({
    description:
      'Workload breakdown across canonical state groups for assigned work items',
  })
  @IsOptional()
  stateGroupBreakdown?: Record<string, number>;

  @ApiProperty({
    description:
      'Workload breakdown across canonical state groups for subscribed work items',
  })
  @IsOptional()
  subscribedStateGroupBreakdown?: Record<string, number>;

  @ApiProperty({ description: 'Workload breakdown across priority levels' })
  @IsOptional()
  priorityBreakdown?: Record<string, number>;

  @ApiProperty({ description: 'Workload and progress breakdown by project' })
  @IsOptional()
  @IsArray()
  projectBreakdown?: import('../types/your-work.types').ProjectWorkloadBreakdown[];

  @ApiProperty({
    description: 'User profile metadata (display name, avatar, joined on)',
  })
  @IsOptional()
  userData?: import('../types/your-work.types').UserProfileData;

  @ApiProperty()
  @IsBoolean()
  success!: boolean;
}
