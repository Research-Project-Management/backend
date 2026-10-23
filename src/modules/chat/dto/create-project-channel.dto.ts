import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProjectChannelDto {
  @ApiProperty({
    description:
      'Name of the project channel (alphanumeric and hyphens, e.g. papers or lab-meeting)',
    example: 'papers',
    maxLength: 50,
  })
  @IsString()
  @IsNotEmpty({ message: 'Channel name is required' })
  @MaxLength(50, { message: 'Channel name cannot exceed 50 characters' })
  @Matches(/^[a-z0-9_-]+$/, {
    message:
      'Channel name must contain only lowercase letters, numbers, hyphens or underscores',
  })
  name!: string;

  @ApiPropertyOptional({
    description: 'Optional channel topic or description',
    example: 'Discussion on relevant literature and references',
    maxLength: 255,
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  topic?: string;
}
