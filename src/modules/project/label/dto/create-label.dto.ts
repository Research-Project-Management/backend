import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProjectLabelDto {
  @ApiProperty({
    description: 'Name of the project label',
    example: 'Infrastructure',
    maxLength: 50,
  })
  @IsString()
  @IsNotEmpty({ message: 'Label name is required' })
  @MaxLength(50, { message: 'Label name cannot exceed 50 characters' })
  name!: string;

  @ApiProperty({
    description: 'Hex color code for the label',
    example: '#3B82F6',
  })
  @IsString()
  @IsNotEmpty({ message: 'Color is required' })
  @Matches(/^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/, {
    message: 'Color must be a valid hex code (e.g. #3B82F6)',
  })
  color!: string;

  @ApiPropertyOptional({
    description: 'Optional description of what this project label represents',
    example: 'Core infrastructure and platform engineering projects',
    maxLength: 200,
  })
  @IsString()
  @IsOptional()
  @MaxLength(200, { message: 'Description cannot exceed 200 characters' })
  description?: string;
}

export class UpdateProjectLabelDto {
  @ApiPropertyOptional({ example: 'Platform & Infra', maxLength: 50 })
  @IsString()
  @IsOptional()
  @MaxLength(50)
  name?: string;

  @ApiPropertyOptional({ example: '#6366F1' })
  @IsString()
  @IsOptional()
  @Matches(/^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/, {
    message: 'Color must be a valid hex code',
  })
  color?: string;

  @ApiPropertyOptional({ example: 'Platform projects', maxLength: 200 })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  description?: string;
}
