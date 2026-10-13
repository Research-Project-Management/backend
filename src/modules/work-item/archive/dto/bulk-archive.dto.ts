import { IsArray, IsString, ArrayNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BulkArchiveDto {
  @ApiPropertyOptional({
    description: 'Array of WorkItem IDs to archive or restore',
    type: [String],
    example: [
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    ],
  })
  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  workItemIds?: string[];

  @ApiPropertyOptional({
    description: 'Array of WorkItem IDs (alias for workItemIds)',
    type: [String],
  })
  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  ids?: string[];

  @ApiPropertyOptional({
    description: 'Project ID',
  })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({
    description: 'Optional note or reason for archiving/restoring',
    example: 'Sprint cleanup',
  })
  @IsOptional()
  @IsString()
  reason?: string;
}
