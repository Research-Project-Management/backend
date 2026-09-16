import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class UpdateProjectLinkDto {
  @ApiPropertyOptional({
    description: 'Updated title for the pinned link',
    example: 'Updated Docs',
    maxLength: 255,
  })
  @IsString()
  @IsOptional()
  @MaxLength(255, { message: 'Title cannot exceed 255 characters' })
  title?: string;

  @ApiPropertyOptional({
    description: 'Updated URL of the resource',
    example: 'https://docs.flux.ac.vn/v2',
  })
  @IsString()
  @IsOptional()
  @IsUrl({}, { message: 'Must be a valid URL' })
  url?: string;
}
