import { IsEnum, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ProjectMemberRole } from '@prisma/client';

export class UpdateProjectMemberDto {
  @ApiProperty({
    description:
      'New role for the project member (owner, coordinator, contributor, reviewer)',
    enum: ProjectMemberRole,
    example: ProjectMemberRole.contributor,
  })
  @IsEnum(ProjectMemberRole, { message: 'Invalid project member role' })
  @IsNotEmpty({ message: 'Role is required' })
  role!: ProjectMemberRole;
}
