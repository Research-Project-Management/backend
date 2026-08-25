import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePasswordDto {
  @ApiProperty({
    description: 'Current account password',
    example: 'OldP@ssw0rd123',
  })
  @IsString()
  @IsNotEmpty({ message: 'Current password is required' })
  currentPassword!: string;

  @ApiProperty({
    description: 'New account password (minimum 6 characters)',
    example: 'NewSecretP@ssw0rd!',
    minLength: 6,
  })
  @IsString()
  @MinLength(6, { message: 'New password must be at least 6 characters' })
  @IsNotEmpty({ message: 'New password is required' })
  newPassword!: string;
}
