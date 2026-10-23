import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryMessagesDto {
  @ApiPropertyOptional({
    description: 'Cursor message ID to load messages before (older messages)',
    example: '01957c91-2345-7890-abcd-ef0123456789',
  })
  @IsUUID('all')
  @IsOptional()
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Number of messages to retrieve (default: 30, max: 100)',
    default: 30,
    minimum: 1,
    maximum: 100,
  })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  @Type(() => Number)
  limit: number = 30;
}
