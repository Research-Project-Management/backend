import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { FileDiffVo } from '../domain/diff';

export class DiffQueryDto {
  @ApiProperty({ description: 'Base baseline version number' })
  @IsInt()
  @Min(1)
  @Type(() => Number)
  baseVersion!: number;

  @ApiProperty({ description: 'Target comparison version number' })
  @IsInt()
  @Min(1)
  @Type(() => Number)
  targetVersion!: number;
}

export class DiffResponseDto {
  @ApiProperty()
  baseVersion!: number;

  @ApiProperty()
  targetVersion!: number;

  @ApiProperty()
  totalAdditions!: number;

  @ApiProperty()
  totalDeletions!: number;

  @ApiProperty()
  filesChanged!: number;

  @ApiProperty({
    description:
      'List of file-level diff results with line hunks and word highlights',
  })
  files!: FileDiffVo[];
}
