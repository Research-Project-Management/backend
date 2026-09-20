import { IsEmail, IsEnum, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Role } from '@prisma/client';

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
    enum: Role,
    default: Role.contributor,
  })
  @IsEnum(Role)
  @IsOptional()
  role?: Role = Role.contributor;
}
