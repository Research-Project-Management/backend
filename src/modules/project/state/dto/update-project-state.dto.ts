import { IsEnum, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ProjectState } from '@prisma/client';

export class UpdateProjectStateDto {
  @ApiProperty({
    description: 'Target lifecycle state of the project',
    enum: ProjectState,
    example: ProjectState.execution,
  })
  @IsEnum(ProjectState, {
    message: 'State must be one of: draft, planning, execution, monitoring, completed, cancelled',
  })
  @IsNotEmpty({ message: 'State is required' })
  state!: ProjectState;
}
