import { IsEnum, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Role } from '@prisma/client';

export class UpdateProjectMemberDto {
  @ApiProperty({
    description:
      'New role for the project member (owner, coordinator, contributor, reviewer)',
    enum: Role,
    example: Role.contributor,
  })
  @IsEnum(Role, { message: 'Invalid project member role' })
  @IsNotEmpty({ message: 'Role is required' })
  role!: Role;
}
