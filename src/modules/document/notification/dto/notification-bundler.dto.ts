import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateNotificationSettingsDto {
  @IsBoolean()
  @IsOptional()
  @ApiPropertyOptional({
    description: 'Whether notification bundling is enabled',
  })
  enabled?: boolean;

  @IsNumber()
  @Min(1)
  @Max(120)
  @IsOptional()
  @ApiPropertyOptional({
    description:
      'Bundling sliding window in minutes (1 - 120, default: 10)',
  })
  windowMinutes?: number;

  @IsBoolean()
  @IsOptional()
  @ApiPropertyOptional({ description: 'Bundle @mention alerts' })
  bundleMentions?: boolean;

  @IsBoolean()
  @IsOptional()
  @ApiPropertyOptional({ description: 'Bundle review comments' })
  bundleComments?: boolean;

  @IsBoolean()
  @IsOptional()
  @ApiPropertyOptional({
    description: 'Bundle track-changes suggestions',
  })
  bundleSuggestions?: boolean;
}

export class FlushBundleDto {
  @IsString()
  @IsOptional()
  @ApiPropertyOptional({
    description: 'Target scope or project ID to flush immediately',
  })
  scopeId?: string;

  @IsString()
  @IsOptional()
  @ApiPropertyOptional({ description: 'Project ID' })
  projectId?: string;
}
