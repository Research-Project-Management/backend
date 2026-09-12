import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum WorkItemUpdateStatus {
  ON_TRACK = 'on_track',
  AT_RISK = 'at_risk',
  OFF_TRACK = 'off_track',
}

export class CreateWorkItemUpdateDto {
  @ApiProperty({
    description: 'Status signal for this update',
    enum: WorkItemUpdateStatus,
    example: WorkItemUpdateStatus.ON_TRACK,
  })
  @IsEnum(WorkItemUpdateStatus)
  @IsNotEmpty()
  status!: WorkItemUpdateStatus;

  @ApiPropertyOptional({
    description: 'Optional comment describing the current status',
    example: 'All tasks on schedule, no blockers.',
    maxLength: 500,
  })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  comment?: string;
}

// Aliases
export const CreateUpdateDto = CreateWorkItemUpdateDto;
export type CreateUpdateDto = CreateWorkItemUpdateDto;
export const UpdateStatus = WorkItemUpdateStatus;
export type UpdateStatus = WorkItemUpdateStatus;

