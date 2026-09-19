import { ApiProperty } from '@nestjs/swagger';
import { ProjectState } from '@prisma/client';

export class ProjectStateMetadataDto {
  @ApiProperty({ enum: ProjectState, example: ProjectState.planning })
  state!: ProjectState;

  @ApiProperty({ example: 'Lên kế hoạch (Planning)' })
  label!: string;

  @ApiProperty({
    example: 'Đang xác định scope, specs, kiến trúc và phân bổ tài nguyên.',
  })
  description!: string;

  @ApiProperty({ example: 2 })
  order!: number;
}

export class ProjectCurrentStateResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  projectId!: string;

  @ApiProperty({ enum: ProjectState, example: ProjectState.execution })
  state!: ProjectState;

  @ApiProperty({ example: 'Đang triển khai (Execution / In Progress)' })
  stateLabel!: string;

  @ApiProperty({
    example: ['planning', 'monitoring', 'completed', 'cancelled'],
    description: 'List of valid states the project can transition to next',
  })
  allowedTransitions!: ProjectState[];
}
