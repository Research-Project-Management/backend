import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class LabelVersionDto {
  @ApiProperty({
    description: 'Named tag or milestone label (e.g. "v1.0-submission")',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  label!: string;

  @ApiPropertyOptional({ description: 'Target Page ID scope' })
  @IsString()
  @IsOptional()
  pageId?: string;
}

export class VersionLabelDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  version!: number;

  @ApiProperty()
  label!: string;

  @ApiPropertyOptional()
  createdById?: string | null;

  @ApiProperty()
  createdAt!: Date;
}
