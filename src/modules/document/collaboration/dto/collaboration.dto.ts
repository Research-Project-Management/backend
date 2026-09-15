import { IsNumber, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CursorPositionDto {
  @ApiPropertyOptional({ description: 'Line number (0-indexed or 1-indexed)' })
  @IsNumber()
  line!: number;

  @ApiPropertyOptional({ description: 'Character offset / column in line' })
  @IsNumber()
  ch!: number;

  @ApiPropertyOptional({ description: 'Optional selection end line' })
  @IsNumber()
  @IsOptional()
  selectionEndLine?: number;

  @ApiPropertyOptional({ description: 'Optional selection end column' })
  @IsNumber()
  @IsOptional()
  selectionEndCh?: number;
}

export class HeartbeatDto {
  @ApiPropertyOptional({ description: 'Current cursor location of the user' })
  @ValidateNested()
  @Type(() => CursorPositionDto)
  @IsOptional()
  cursor?: CursorPositionDto;
}
