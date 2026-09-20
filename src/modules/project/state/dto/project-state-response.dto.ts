import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectState } from '@prisma/client';

export class ProjectCurrentStateResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  projectId!: string;

  @ApiPropertyOptional({
    example: '01957c91-2345-7890-abcd-ef0123456789',
    nullable: true,
  })
  stateId!: string | null;

  @ApiPropertyOptional({
    description: 'Current active project state details, or null if unassigned',
    nullable: true,
  })
  state!: ProjectState | null;

  @ApiProperty({
    example: 'Triển khai & Thực nghiệm',
  })
  stateLabel!: string;
}


