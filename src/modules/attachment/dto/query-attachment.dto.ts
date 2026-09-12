import { IsEnum, IsOptional, IsString, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { EntityType } from '@prisma/client';

export class QueryAttachmentDto {
  @ApiPropertyOptional({ enum: EntityType, description: 'Filter by entity type' })
  @IsOptional()
  @IsEnum(EntityType)
  entityType?: EntityType;

  @ApiPropertyOptional({ description: 'Filter by entity ID' })
  @IsOptional()
  @IsString()
  entityId?: string;

  @ApiPropertyOptional({ description: 'Filter by workspace ID' })
  @IsOptional()
  @IsString()
  workspaceId?: string;

  @ApiPropertyOptional({ description: 'Filter by project ID' })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 50;
}
