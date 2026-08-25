import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProfileDto {
  @ApiPropertyOptional({
    description: 'Updated user display name',
    example: 'Dr. Alan Turing',
  })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({
    description: 'Updated user avatar URL',
    example: 'https://cdn.flux.ai/avatars/new-avatar.png',
  })
  @IsString()
  @IsOptional()
  avatar?: string;
}
