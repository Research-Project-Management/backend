import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for updating user settings and research preferences.
 */
export class UpdateUserSettingsDto {
  @ApiPropertyOptional({
    description: 'Display name for user',
    example: 'Dr. Alan Turing',
    maxLength: 100,
  })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description: 'Avatar image URL',
    example: 'https://example.com/avatars/user.png',
  })
  @IsString()
  @IsOptional()
  avatar?: string;

  @ApiPropertyOptional({
    description: 'User timezone',
    example: 'Asia/Ho_Chi_Minh',
  })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional({
    description: 'Subscription plan',
    example: 'free',
  })
  @IsString()
  @IsOptional()
  plan?: string;

  @ApiPropertyOptional({
    description: 'User preferences & settings (theme, locale, etc.)',
    example: { theme: 'system', locale: 'en' },
  })
  @IsObject()
  @IsOptional()
  settings?: Record<string, unknown>;
}
