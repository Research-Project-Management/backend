import { IsOptional, IsString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class CursorPaginationQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;
}

export interface CursorPaginatedResult<T> {
  items: T[];
  meta: {
    cursor?: string;
    hasNextPage: boolean;
    totalCount?: number;
  };
}
