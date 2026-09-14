import { IsEmail, IsEnum, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectMemberRole } from '@prisma/client';

export class CreateProjectInvitationDto {
  @ApiProperty({
    description: 'Email address of the invited user',
    example: 'colleague@example.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @ApiPropertyOptional({
    description: 'Assigned project member role',
    enum: ProjectMemberRole,
    default: ProjectMemberRole.contributor,
  })
  @IsEnum(ProjectMemberRole)
  @IsOptional()
  role?: ProjectMemberRole = ProjectMemberRole.contributor;
}
