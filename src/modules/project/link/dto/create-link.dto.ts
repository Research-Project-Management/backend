import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUrl, MaxLength } from 'class-validator';

export class CreateLinkDto {
  @ApiProperty({
    description: 'Display title for the pinned link',
    example: 'Project Documentation',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty({ message: 'Title is required' })
  @MaxLength(255, { message: 'Title cannot exceed 255 characters' })
  title!: string;

  @ApiProperty({
    description: 'Absolute URL of the resource',
    example: 'https://docs.flux.ac.vn',
  })
  @IsString()
  @IsNotEmpty({ message: 'URL is required' })
  @IsUrl({ require_tld: false }, { message: 'Must be a valid URL' })
  url!: string;
}

export const CreateProjectLinkDto = CreateLinkDto;
export type CreateProjectLinkDto = CreateLinkDto;
