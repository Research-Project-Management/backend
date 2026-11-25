import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RestoreVersionDto {
  @ApiProperty({ description: 'Historical version number to restore from' })
  @IsInt()
  @Min(1)
  @Type(() => Number)
  targetVersion!: number;

  @ApiPropertyOptional({ description: 'Target Page ID scope' })
  @IsString()
  @IsOptional()
  pageId?: string;
}

export class RestoreSingleFileDto {
  @ApiProperty({
    description: 'Relative path of the file in the version snapshot to restore',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  pathname!: string;

  @ApiPropertyOptional({
    description: 'Optional document or file identifier hint',
  })
  @IsString()
  @IsOptional()
  fileId?: string;

  @ApiPropertyOptional({ description: 'Target Page ID scope' })
  @IsString()
  @IsOptional()
  pageId?: string;
}

export class RestoreSingleFileResponseDto {
  @ApiProperty()
  path!: string;

  @ApiProperty()
  version!: number;

  @ApiProperty()
  newVersion!: number;

  @ApiPropertyOptional({ nullable: true })
  docId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  fileId?: string | null;

  @ApiPropertyOptional()
  content?: string;

  @ApiPropertyOptional()
  rev?: number;
}
