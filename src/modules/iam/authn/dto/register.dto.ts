import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({
    description: 'User email address',
    example: 'researcher@flux.ac.uk',
  })
  @IsEmail({}, { message: 'Invalid email address' })
  @IsNotEmpty({ message: 'Email is required' })
  email!: string;

  @ApiProperty({
    description: 'Account password (minimum 8 characters)',
    example: 'SecretP@ssw0rd!',
    minLength: 8,
  })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @IsNotEmpty({ message: 'Password is required' })
  password!: string;

  @ApiPropertyOptional({
    description: 'Display name',
    example: 'Dr. Alan Turing',
  })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({
    description: 'Avatar image URL',
    example: 'https://cdn.flux.ai/avatars/user.png',
  })
  @IsString()
  @IsOptional()
  avatar?: string;
}
