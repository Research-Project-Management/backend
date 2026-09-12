import { IsArray, IsString, ArrayNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BulkArchiveDto {
  @ApiProperty({
    description: 'Array of task IDs to archive or restore',
    type: [String],
    example: ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  taskIds!: string[];

  @ApiPropertyOptional({
    description: 'Optional note or reason for archiving/restoring',
    example: 'Sprint cleanup',
  })
  @IsOptional()
  @IsString()
  reason?: string;
}
