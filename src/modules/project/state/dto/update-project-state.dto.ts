import { IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProjectStateDto {
  @ApiPropertyOptional({
    description: 'Target state ID of the project, or null to unassign',
    example: '01957c91-2345-7890-abcd-ef0123456789',
    nullable: true,
  })
  @IsUUID('all', { message: 'stateId must be a valid UUID' })
  @IsOptional()
  stateId?: string | null;
}

