import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectUpdateStatus } from '@prisma/client';

export class UpdateProjectStatusUpdateDto {
  @ApiPropertyOptional({
    enum: ProjectUpdateStatus,
    description: 'Project health status: on_track, at_risk, off_track',
    example: 'on_track',
  })
  @IsEnum(ProjectUpdateStatus)
  @IsOptional()
  status?: ProjectUpdateStatus;

  @ApiPropertyOptional({
    description: 'Summary of progress, blockers, or milestone notes',
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  message?: string;
}
