import { IsEnum, IsOptional, IsString, IsUUID, IsBoolean } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export enum ExportFormat {
  CSV = 'csv',
  JSON = 'json',
}

export class ExportWorkItemsQueryDto {
  @ApiPropertyOptional({
    enum: ExportFormat,
    default: ExportFormat.CSV,
    description: 'Export file format: csv or json',
  })
  @IsOptional()
  @IsEnum(ExportFormat)
  format?: ExportFormat = ExportFormat.CSV;

  @ApiPropertyOptional({ description: 'Filter by cycle UUID' })
  @IsOptional()
  @IsUUID('4')
  cycleId?: string;

  @ApiPropertyOptional({ description: 'Filter by column/state ID' })
  @IsOptional()
  @IsString()
  columnId?: string;

  @ApiPropertyOptional({ description: 'Filter by priority: urgent, high, medium, low, none' })
  @IsOptional()
  @IsString()
  priority?: string;

  @ApiPropertyOptional({ description: 'Filter by assignee UUID' })
  @IsOptional()
  @IsUUID('4')
  assigneeId?: string;

  @ApiPropertyOptional({ description: 'Filter by completed status' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  completed?: boolean;

  @ApiPropertyOptional({ description: 'Search term in title or description' })
  @IsOptional()
  @IsString()
  search?: string;
}
