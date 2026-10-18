import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ProjectUpdateStatus } from '@prisma/client';

export class CreateProjectStatusUpdateDto {
  @ApiProperty({
    enum: ProjectUpdateStatus,
    description: 'Project health status: on_track, at_risk, off_track',
    example: 'on_track',
  })
  @IsEnum(ProjectUpdateStatus)
  @IsNotEmpty()
  status!: ProjectUpdateStatus;

  @ApiProperty({
    description: 'Summary of progress, blockers, or milestone notes',
    example:
      'Sprint 2 is 80% complete, frontend and backend integration running smoothly.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  message!: string;
}
